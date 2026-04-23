require('dotenv').config();

/**
 * CobrarAí — Backend Completo
 * Node.js + sqlite3 + PIX (OpenPix) + WhatsApp (Evolution API) + Régua automática
 * Porta: 3001
 */

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'cobrarai_secret_2024';
const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'cobrarai.db');

const OPENPIX_APP_ID     = process.env.OPENPIX_APP_ID     || '';
const EVOLUTION_URL      = process.env.EVOLUTION_URL      || '';
const EVOLUTION_KEY      = process.env.EVOLUTION_KEY      || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || '';

// VAPI — plataforma (único para todos os lojistas)
const VAPI_KEY          = process.env.VAPI_KEY          || '';
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || '';
const VAPI_PHONE_ID     = process.env.VAPI_PHONE_ID     || '';

// ─── BANCO DE DADOS ───────────────────────────────────────────────────────────
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) { console.error('Erro ao abrir banco:', err.message); process.exit(1); }
  console.log('✅ Banco de dados conectado:', DB_PATH);
});

// Helper: transformar callbacks em promises
const dbRun = (sql, params = []) => new Promise((res, rej) =>
  db.run(sql, params, function (err) { err ? rej(err) : res(this); }));

const dbGet = (sql, params = []) => new Promise((res, rej) =>
  db.get(sql, params, (err, row) => { err ? rej(err) : res(row); }));

const dbAll = (sql, params = []) => new Promise((res, rej) =>
  db.all(sql, params, (err, rows) => { err ? rej(err) : res(rows); }));

// Criar tabelas
async function iniciarBanco() {
  await dbRun('PRAGMA journal_mode = WAL');
  await dbRun('PRAGMA foreign_keys = ON');
  // Migrações
  await dbRun(`ALTER TABLE lojistas ADD COLUMN nome_empresa TEXT`).catch(() => {});
  await dbRun(`ALTER TABLE regua ADD COLUMN roteiro_voz TEXT`).catch(() => {});
  await dbRun(`ALTER TABLE config ADD COLUMN vapi_phone_id TEXT`).catch(() => {});
  await dbRun(`ALTER TABLE config ADD COLUMN horarios_envio TEXT`).catch(() => {});
  await dbRun(`ALTER TABLE config ADD COLUMN horarios_ligacao TEXT`).catch(() => {});
  await dbRun(`CREATE TABLE IF NOT EXISTS admin_colaboradores (
    id        TEXT PRIMARY KEY,
    nome      TEXT NOT NULL,
    email     TEXT UNIQUE NOT NULL,
    criado_em TEXT DEFAULT (datetime('now'))
  )`).catch(() => {});

  await dbRun(`CREATE TABLE IF NOT EXISTS lojistas (
    id          TEXT PRIMARY KEY,
    nome        TEXT NOT NULL,
    nome_empresa TEXT,
    email       TEXT UNIQUE NOT NULL,
    senha_hash  TEXT NOT NULL,
    telefone    TEXT,
    pix_chave   TEXT,
    criado_em   TEXT DEFAULT (datetime('now'))
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS clientes (
    id          TEXT PRIMARY KEY,
    lojista_id  TEXT NOT NULL,
    nome        TEXT NOT NULL,
    cpf         TEXT,
    telefone    TEXT,
    email       TEXT,
    tipo        TEXT DEFAULT 'produto',
    criado_em   TEXT DEFAULT (datetime('now'))
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS cobrancas (
    id                  TEXT PRIMARY KEY,
    lojista_id          TEXT NOT NULL,
    cliente_id          TEXT NOT NULL,
    descricao           TEXT,
    valor_total         REAL NOT NULL,
    total_parcelas      INTEGER DEFAULT 1,
    taxa_juros          REAL DEFAULT 0,
    data_primeira_parc  TEXT NOT NULL,
    status              TEXT DEFAULT 'ativa',
    criado_em           TEXT DEFAULT (datetime('now'))
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS parcelas (
    id          TEXT PRIMARY KEY,
    cobranca_id TEXT NOT NULL,
    numero      INTEGER NOT NULL,
    valor       REAL NOT NULL,
    vencimento  TEXT NOT NULL,
    status      TEXT DEFAULT 'pendente',
    pix_id      TEXT,
    pix_code    TEXT,
    pix_qr      TEXT,
    pago_em     TEXT,
    criado_em   TEXT DEFAULT (datetime('now'))
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS regua (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lojista_id  TEXT NOT NULL,
    dia_atraso  INTEGER NOT NULL,
    acao_wpp    INTEGER DEFAULT 1,
    acao_voz    INTEGER DEFAULT 0,
    mensagem_wpp TEXT,
    roteiro_voz TEXT,
    ativo       INTEGER DEFAULT 1,
    UNIQUE(lojista_id, dia_atraso)
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS disparos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    parcela_id  TEXT NOT NULL,
    lojista_id  TEXT NOT NULL,
    tipo        TEXT NOT NULL,
    dia_atraso  INTEGER,
    enviado_em  TEXT DEFAULT (datetime('now')),
    status      TEXT DEFAULT 'ok',
    erro        TEXT
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS config (
    lojista_id        TEXT PRIMARY KEY,
    evolution_url     TEXT,
    evolution_key     TEXT,
    evolution_inst    TEXT,
    openpix_app_id    TEXT,
    vapi_key          TEXT,
    vapi_assistant_id TEXT
  )`);

  await migrarRoteirosVoz();
  console.log('✅ Tabelas prontas');
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const uid = () => crypto.randomUUID();

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Token necessário' });
  try {
    req.lojista = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ erro: 'Token inválido' });
  }
}

function addDias(dataStr, dias) {
  const d = new Date(dataStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().split('T')[0];
}

function hoje() {
  return new Date().toISOString().split('T')[0];
}

function diasAtraso(vencimento) {
  const v = new Date(vencimento + 'T12:00:00Z');
  const h = new Date(hoje() + 'T12:00:00Z');
  return Math.floor((h - v) / 86400000);
}

async function criarReguaPadrao(lojista_id) {
  const mensagens = [
    { dia: 0,  msg: 'Olá {nome}! 👋 Aqui é da *{empresa}*. Sua parcela de *{valor}* vence *hoje*. Pague agora via PIX: {link}' },
    { dia: 1,  msg: 'Oi {nome}! Aqui é da *{empresa}*. Sua parcela de *{valor}* venceu ontem. Ainda dá tempo de regularizar: {link}' },
    { dia: 2,  msg: '{nome}, passando aqui pela *{empresa}*. Sua parcela de *{valor}* está em aberto há 2 dias. Pague com PIX: {link}' },
    { dia: 3,  msg: 'Olá {nome}! 🔔 Aviso da *{empresa}*: sua parcela de *{valor}* está em atraso há 3 dias. Regularize: {link}' },
    { dia: 4,  msg: '{nome}, sua parcela de *{valor}* com a *{empresa}* está há 4 dias em aberto. Evite juros, pague agora: {link}' },
    { dia: 5,  msg: 'Oi {nome}! ⚠️ Já são 5 dias de atraso na sua parcela de *{valor}* com a *{empresa}*. Pague via PIX: {link}' },
    { dia: 6,  msg: '{nome}, são quase uma semana de atraso. Sua parcela de *{valor}* na *{empresa}* segue em aberto. PIX: {link}' },
    { dia: 7,  msg: '⚠️ {nome}, sua parcela de *{valor}* com a *{empresa}* está há 7 dias em atraso. Regularize para evitar negativação: {link}' },
    { dia: 8,  msg: 'Olá {nome}! Aqui é da *{empresa}*. Sua parcela de *{valor}* está atrasada. Podemos conversar? Pague via PIX: {link}' },
    { dia: 9,  msg: '{nome}, estamos tentando entrar em contato. Sua parcela de *{valor}* na *{empresa}* está há 9 dias em aberto: {link}' },
    { dia: 10, msg: '🔴 {nome}, 10 dias de atraso na *{empresa}*. Valor: *{valor}*. Regularize agora e evite problemas: {link}' },
    { dia: 12, msg: '{nome}, sua pendência de *{valor}* com a *{empresa}* completa 12 dias hoje. Acesse e pague via PIX: {link}' },
    { dia: 14, msg: '⚠️ {nome}, são 2 semanas de atraso na *{empresa}*. Parcela de *{valor}* ainda em aberto. Pague: {link}' },
    { dia: 15, msg: '🔴 {nome}, 15 dias de atraso com a *{empresa}*. Valor: *{valor}*. Último prazo antes de restrições: {link}' },
    { dia: 17, msg: '{nome}, a *{empresa}* aguarda a regularização de *{valor}*. Já são 17 dias. Pague via PIX agora: {link}' },
    { dia: 20, msg: '🚨 {nome}, 20 dias de atraso com a *{empresa}*. Sua parcela de *{valor}* pode ser enviada ao SPC/Serasa: {link}' },
    { dia: 22, msg: '{nome}, são 22 dias sem regularização na *{empresa}*. Valor: *{valor}*. Resolva antes que piore: {link}' },
    { dia: 25, msg: '⚠️ {nome}, aviso importante da *{empresa}*: 25 dias de atraso em *{valor}*. Regularize: {link}' },
    { dia: 27, msg: '{nome}, estamos a 3 dias do prazo final. Sua parcela de *{valor}* com a *{empresa}* está prestes a ser negativada: {link}' },
    { dia: 30, msg: '🔴 {nome}, 30 dias de atraso! A *{empresa}* notificará o SPC/Serasa em breve. Regularize *{valor}* agora: {link}' },
    { dia: 33, msg: '{nome}, sua dívida de *{valor}* com a *{empresa}* já está no processo de negativação. Evite, pague via PIX: {link}' },
    { dia: 35, msg: '🚨 {nome}, última tentativa amigável da *{empresa}*. Parcela de *{valor}* em atraso há 35 dias. Pague: {link}' },
    { dia: 38, msg: '{nome}, a *{empresa}* comunica que seu débito de *{valor}* será encaminhado para cobrança judicial se não quitado: {link}' },
    { dia: 40, msg: '⚠️ {nome}, 40 dias de atraso com a *{empresa}*. Seu nome pode ser incluído no SPC/Serasa. Pague *{valor}*: {link}' },
    { dia: 45, msg: '🔴 {nome}, 45 dias de inadimplência com a *{empresa}*. Regularize *{valor}* urgente para limpar seu nome: {link}' },
    { dia: 50, msg: '{nome}, sua pendência de *{valor}* com a *{empresa}* passa de 50 dias. Ainda podemos resolver: {link}' },
    { dia: 55, msg: '🚨 {nome}, 55 dias de atraso com a *{empresa}*. Última chance antes da negativação definitiva. Pague *{valor}*: {link}' },
    { dia: 60, msg: '🔴 {nome}, 60 dias! A *{empresa}* formalizará a negativação do seu débito de *{valor}*. Regularize: {link}' },
    { dia: 75, msg: '{nome}, seu débito de *{valor}* com a *{empresa}* está negativado. Entre em contato para negociar: {link}' },
    { dia: 90, msg: '🚨 {nome}, 90 dias de atraso com a *{empresa}*. Seu caso será encaminhado para assessoria jurídica. Pague *{valor}*: {link}' },
  ];
  const roteiros = {
    0:  'Olá, {nome}! Aqui é um contato da {empresa}. Estou ligando para avisar que sua parcela de {valor} vence hoje. Você consegue efetuar o pagamento ainda hoje? Enviamos o código PIX pelo WhatsApp. Se preferir, posso aguardar enquanto você acessa. Caso tenha alguma dificuldade, me informe e podemos verificar uma solução.',
    1:  'Olá, {nome}! Aqui é da {empresa}. Sua parcela de {valor} venceu ontem e ainda está em aberto. Você consegue realizar o pagamento hoje? O PIX foi enviado pelo WhatsApp. Se precisar de um prazo ou tiver alguma dificuldade, por favor me informe para registrarmos.',
    3:  'Olá, {nome}. Aqui é da {empresa}. Sua parcela de {valor} está em atraso há 3 dias. Gostaríamos de entender sua situação. Você consegue quitar hoje ou prefere combinar uma data? Basta me informar e registramos o acordo. O PIX está disponível no WhatsApp.',
    7:  'Olá, {nome}! Aqui é da {empresa}. Estou ligando porque sua parcela de {valor} está em atraso há 7 dias. Você consegue pagar hoje ou agendar para amanhã? Posso registrar sua promessa de pagamento agora mesmo. O código PIX foi enviado pelo WhatsApp. Se tiver alguma dificuldade financeira, me conte para buscarmos uma solução.',
    15: 'Boa tarde, {nome}. Aqui é da {empresa}. Sua parcela de {valor} está em atraso há 15 dias. Para evitar a inclusão do seu nome no SPC e Serasa, precisamos regularizar essa situação. Você consegue pagar hoje ou prefere agendar? Me informe uma data e registramos seu compromisso.',
    30: 'Olá, {nome}. Aqui é da {empresa}. Sua dívida de {valor} completa 30 dias em atraso hoje. Esse é nosso aviso antes de encaminharmos para negativação. Você consegue quitar hoje ou negociar uma data? Ainda temos como resolver amigavelmente. Por favor, me informe sua situação.',
    60: 'Olá, {nome}. Aqui é da {empresa}. Sua pendência de {valor} está há 60 dias em aberto e seu nome já foi incluído no SPC e Serasa. Para retirar a restrição, é necessário regularizar. Você deseja negociar o pagamento hoje? Me informe para registrarmos e iniciarmos a baixa da restrição.',
  };
  // dias com ligação ativa por padrão: 0, 1, 3, 7, 15, 30, 60
  const diasComVoz = new Set([0, 1, 3, 7, 15, 30, 60]);
  for (const m of mensagens) {
    await dbRun(
      'INSERT OR IGNORE INTO regua (lojista_id, dia_atraso, acao_wpp, acao_voz, mensagem_wpp, roteiro_voz, ativo) VALUES (?,?,1,?,?,?,1)',
      [lojista_id, m.dia, diasComVoz.has(m.dia) ? 1 : 0, m.msg, roteiros[m.dia] || null]
    );
  }
}

// Migração de roteiros: atualiza lojistas existentes que não têm roteiro_voz configurado
async function migrarRoteirosVoz() {
  const roteiros = {
    0:  'Olá, {nome}! Aqui é um contato da {empresa}. Estou ligando para avisar que sua parcela de {valor} vence hoje. Você consegue efetuar o pagamento ainda hoje? Enviamos o código PIX pelo WhatsApp. Se preferir, posso aguardar enquanto você acessa. Caso tenha alguma dificuldade, me informe e podemos verificar uma solução.',
    1:  'Olá, {nome}! Aqui é da {empresa}. Sua parcela de {valor} venceu ontem e ainda está em aberto. Você consegue realizar o pagamento hoje? O PIX foi enviado pelo WhatsApp. Se precisar de um prazo ou tiver alguma dificuldade, por favor me informe para registrarmos.',
    3:  'Olá, {nome}. Aqui é da {empresa}. Sua parcela de {valor} está em atraso há 3 dias. Gostaríamos de entender sua situação. Você consegue quitar hoje ou prefere combinar uma data? Basta me informar e registramos o acordo. O PIX está disponível no WhatsApp.',
    7:  'Olá, {nome}! Aqui é da {empresa}. Estou ligando porque sua parcela de {valor} está em atraso há 7 dias. Você consegue pagar hoje ou agendar para amanhã? Posso registrar sua promessa de pagamento agora mesmo. O código PIX foi enviado pelo WhatsApp. Se tiver alguma dificuldade financeira, me conte para buscarmos uma solução.',
    15: 'Boa tarde, {nome}. Aqui é da {empresa}. Sua parcela de {valor} está em atraso há 15 dias. Para evitar a inclusão do seu nome no SPC e Serasa, precisamos regularizar essa situação. Você consegue pagar hoje ou prefere agendar? Me informe uma data e registramos seu compromisso.',
    30: 'Olá, {nome}. Aqui é da {empresa}. Sua dívida de {valor} completa 30 dias em atraso hoje. Esse é nosso aviso antes de encaminharmos para negativação. Você consegue quitar hoje ou negociar uma data? Ainda temos como resolver amigavelmente. Por favor, me informe sua situação.',
    60: 'Olá, {nome}. Aqui é da {empresa}. Sua pendência de {valor} está há 60 dias em aberto e seu nome já foi incluído no SPC e Serasa. Para retirar a restrição, é necessário regularizar. Você deseja negociar o pagamento hoje? Me informe para registrarmos e iniciarmos a baixa da restrição.',
  };
  for (const [dia, roteiro] of Object.entries(roteiros)) {
    await dbRun(
      `UPDATE regua SET roteiro_voz=?, acao_voz=1 WHERE dia_atraso=? AND (roteiro_voz IS NULL OR roteiro_voz='')`,
      [roteiro, parseInt(dia)]
    );
  }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/cadastro', async (req, res) => {
  try {
    const { nome, email, senha, telefone } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ erro: 'Campos obrigatórios: nome, email, senha' });
    const existe = await dbGet('SELECT id FROM lojistas WHERE email = ?', [email]);
    if (existe) return res.status(400).json({ erro: 'E-mail já cadastrado' });
    const id = uid();
    const senha_hash = await bcrypt.hash(senha, 10);
    await dbRun('INSERT INTO lojistas (id, nome, email, senha_hash, telefone) VALUES (?,?,?,?,?)', [id, nome, email, senha_hash, telefone || null]);
    await dbRun('INSERT INTO config (lojista_id) VALUES (?)', [id]);
    await criarReguaPadrao(id);
    const token = jwt.sign({ id, email, nome }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, lojista: { id, nome, email } });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const lojista = await dbGet('SELECT * FROM lojistas WHERE email = ?', [email]);
    if (!lojista) return res.status(401).json({ erro: 'E-mail ou senha inválidos' });
    const ok = await bcrypt.compare(senha, lojista.senha_hash);
    if (!ok) return res.status(401).json({ erro: 'E-mail ou senha inválidos' });
    const token = jwt.sign({ id: lojista.id, email: lojista.email, nome: lojista.nome }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, lojista: { id: lojista.id, nome: lojista.nome, email: lojista.email } });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const l = await dbGet('SELECT id, nome, nome_empresa, email, telefone, pix_chave FROM lojistas WHERE id = ?', [req.lojista.id]);
  res.json(l);
});

app.put('/api/auth/perfil', authMiddleware, async (req, res) => {
  try {
    const { nome, nome_empresa } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome é obrigatório' });
    await dbRun('UPDATE lojistas SET nome=?, nome_empresa=? WHERE id=?', [nome, nome_empresa || null, req.lojista.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/auth/senha', authMiddleware, async (req, res) => {
  try {
    const { senha_atual, senha_nova } = req.body;
    if (!senha_atual || !senha_nova) return res.status(400).json({ erro: 'Preencha todos os campos' });
    if (senha_nova.length < 6) return res.status(400).json({ erro: 'Nova senha deve ter ao menos 6 caracteres' });
    const lojista = await dbGet('SELECT senha_hash FROM lojistas WHERE id=?', [req.lojista.id]);
    const ok = await bcrypt.compare(senha_atual, lojista.senha_hash);
    if (!ok) return res.status(401).json({ erro: 'Senha atual incorreta' });
    const hash = await bcrypt.hash(senha_nova, 10);
    await dbRun('UPDATE lojistas SET senha_hash=? WHERE id=?', [hash, req.lojista.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── CLIENTES ─────────────────────────────────────────────────────────────────
app.get('/api/clientes', authMiddleware, async (req, res) => {
  try {
    const clientes = await dbAll(`
      SELECT c.*,
        COUNT(DISTINCT cob.id) as total_cobrancas,
        COUNT(CASE WHEN p.status != 'pago' AND p.vencimento < date('now') THEN 1 END) as parcelas_atrasadas,
        COALESCE(SUM(CASE WHEN p.status != 'pago' AND p.vencimento < date('now') THEN p.valor END), 0) as valor_em_atraso
      FROM clientes c
      LEFT JOIN cobrancas cob ON cob.cliente_id = c.id
      LEFT JOIN parcelas p ON p.cobranca_id = cob.id
      WHERE c.lojista_id = ?
      GROUP BY c.id
      ORDER BY c.nome
    `, [req.lojista.id]);
    res.json(clientes);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/clientes', authMiddleware, async (req, res) => {
  try {
    const { nome, cpf, telefone, email, tipo } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome é obrigatório' });
    const id = uid();
    await dbRun('INSERT INTO clientes (id, lojista_id, nome, cpf, telefone, email, tipo) VALUES (?,?,?,?,?,?,?)',
      [id, req.lojista.id, nome, cpf || null, telefone || null, email || null, tipo || 'produto']);
    res.json({ id, nome });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/clientes/:id', authMiddleware, async (req, res) => {
  const { nome, cpf, telefone, email, tipo } = req.body;
  await dbRun('UPDATE clientes SET nome=?, cpf=?, telefone=?, email=?, tipo=? WHERE id=? AND lojista_id=?',
    [nome, cpf, telefone, email, tipo, req.params.id, req.lojista.id]);
  res.json({ ok: true });
});

app.delete('/api/clientes/:id', authMiddleware, async (req, res) => {
  await dbRun('DELETE FROM clientes WHERE id=? AND lojista_id=?', [req.params.id, req.lojista.id]);
  res.json({ ok: true });
});

// ─── PIX (OpenPix) ────────────────────────────────────────────────────────────
async function gerarPixOpenPix(lojista_id, parcelaId, valor, descricao, clienteNome) {
  const cfg = await dbGet('SELECT openpix_app_id FROM config WHERE lojista_id = ?', [lojista_id]);
  const appId = cfg?.openpix_app_id || OPENPIX_APP_ID;
  if (!appId) return null;
  try {
    const r = await fetch('https://api.openpix.com.br/api/v1/charge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: appId },
      body: JSON.stringify({
        correlationID: parcelaId,
        value: Math.round(valor * 100),
        comment: descricao || 'Cobrança CobrarAí',
        customer: { name: clienteNome },
      }),
    });
    const d = await r.json();
    if (d.charge) return {
      pix_id: d.charge.correlationID,
      pix_code: d.charge.brCode,
      pix_qr: d.charge.qrCodeImage,
      link: d.charge.paymentLinkUrl,
    };
  } catch (e) { console.error('OpenPix erro:', e.message); }
  return null;
}

// ─── COBRANÇAS ────────────────────────────────────────────────────────────────
app.get('/api/cobrancas/dashboard/resumo', authMiddleware, async (req, res) => {
  try {
    const lId = req.lojista.id;
    const emAberto  = await dbGet(`SELECT COUNT(*) as qtd, COALESCE(SUM(p.valor),0) as total FROM parcelas p JOIN cobrancas c ON c.id=p.cobranca_id WHERE c.lojista_id=? AND p.status='pendente'`, [lId]);
    const atrasadas = await dbGet(`SELECT COUNT(*) as qtd, COALESCE(SUM(p.valor),0) as total FROM parcelas p JOIN cobrancas c ON c.id=p.cobranca_id WHERE c.lojista_id=? AND p.status!='pago' AND p.vencimento < date('now')`, [lId]);
    const recebidoMes = await dbGet(`SELECT COUNT(*) as qtd, COALESCE(SUM(p.valor),0) as total FROM parcelas p JOIN cobrancas c ON c.id=p.cobranca_id WHERE c.lojista_id=? AND p.status='pago' AND strftime('%Y-%m', p.pago_em) = strftime('%Y-%m', 'now')`, [lId]);
    const prometeu  = await dbGet(`SELECT COUNT(*) as qtd FROM parcelas p JOIN cobrancas c ON c.id=p.cobranca_id WHERE c.lojista_id=? AND p.status='prometeu'`, [lId]);
    res.json({ em_aberto: emAberto, atrasadas, recebido_mes: recebidoMes, prometeu });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/cobrancas', authMiddleware, async (req, res) => {
  try {
    const cobs = await dbAll(`
      SELECT cob.*, cli.nome as cliente_nome,
        SUM(CASE WHEN p.status = 'pago' THEN 1 ELSE 0 END) as parcelas_pagas,
        SUM(CASE WHEN p.status != 'pago' AND p.vencimento < date('now') THEN 1 ELSE 0 END) as parcelas_atrasadas
      FROM cobrancas cob
      JOIN clientes cli ON cli.id = cob.cliente_id
      LEFT JOIN parcelas p ON p.cobranca_id = cob.id
      WHERE cob.lojista_id = ?
      GROUP BY cob.id
      ORDER BY cob.criado_em DESC
    `, [req.lojista.id]);
    res.json(cobs);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/cobrancas', authMiddleware, async (req, res) => {
  try {
    const { cliente_id, descricao, valor_total, total_parcelas, taxa_juros, data_primeira_parcela } = req.body;
    if (!cliente_id || !valor_total) return res.status(400).json({ erro: 'cliente_id e valor_total são obrigatórios' });
    const cliente = await dbGet('SELECT * FROM clientes WHERE id=? AND lojista_id=?', [cliente_id, req.lojista.id]);
    if (!cliente) return res.status(404).json({ erro: 'Cliente não encontrado' });

    const cobId = uid();
    const nParcelas = parseInt(total_parcelas) || 1;
    const juros = parseFloat(taxa_juros) || 0;
    const valorComJuros = valor_total * (1 + juros / 100);
    const valorParcela = valorComJuros / nParcelas;
    const dataPrimeira = data_primeira_parcela || addDias(hoje(), 30);

    await dbRun(
      'INSERT INTO cobrancas (id, lojista_id, cliente_id, descricao, valor_total, total_parcelas, taxa_juros, data_primeira_parc) VALUES (?,?,?,?,?,?,?,?)',
      [cobId, req.lojista.id, cliente_id, descricao || null, valor_total, nParcelas, juros, dataPrimeira]
    );

    const parcelas = [];
    for (let i = 0; i < nParcelas; i++) {
      const parcelaId = uid();
      const vencimento = i === 0 ? dataPrimeira : addDias(dataPrimeira, i * 30);
      await dbRun('INSERT INTO parcelas (id, cobranca_id, numero, valor, vencimento) VALUES (?,?,?,?,?)',
        [parcelaId, cobId, i + 1, valorParcela, vencimento]);

      let pixData = null;
      if (i === 0) {
        pixData = await gerarPixOpenPix(req.lojista.id, parcelaId, valorParcela, `${descricao || 'Cobrança'} - Parcela 1/${nParcelas}`, cliente.nome);
        if (pixData) await dbRun('UPDATE parcelas SET pix_id=?, pix_code=?, pix_qr=? WHERE id=?',
          [pixData.pix_id, pixData.pix_code, pixData.pix_qr, parcelaId]);
      }
      parcelas.push({ id: parcelaId, numero: i + 1, valor: valorParcela, vencimento, ...(pixData || {}) });
    }
    res.json({ id: cobId, parcelas });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/cobrancas/:id/parcelas', authMiddleware, async (req, res) => {
  try {
    const parcelas = await dbAll(`
      SELECT p.* FROM parcelas p
      JOIN cobrancas c ON c.id = p.cobranca_id
      WHERE p.cobranca_id = ? AND c.lojista_id = ?
      ORDER BY p.numero
    `, [req.params.id, req.lojista.id]);
    res.json(parcelas);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/cobrancas/:id', authMiddleware, async (req, res) => {
  try {
    const { descricao } = req.body;
    await dbRun('UPDATE cobrancas SET descricao=? WHERE id=? AND lojista_id=?',
      [descricao || null, req.params.id, req.lojista.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/cobrancas/parcela/:id/editar', authMiddleware, async (req, res) => {
  try {
    const { valor, vencimento, status } = req.body;
    await dbRun(`UPDATE parcelas SET
      valor=COALESCE(?,valor),
      vencimento=COALESCE(?,vencimento),
      status=COALESCE(?,status)
      WHERE id=? AND cobranca_id IN (SELECT id FROM cobrancas WHERE lojista_id=?)`,
      [valor || null, vencimento || null, status || null, req.params.id, req.lojista.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/cobrancas/parcela/:id/pago', authMiddleware, async (req, res) => {
  await dbRun(`UPDATE parcelas SET status='pago', pago_em=datetime('now') WHERE id=? AND cobranca_id IN (SELECT id FROM cobrancas WHERE lojista_id=?)`,
    [req.params.id, req.lojista.id]);
  res.json({ ok: true });
});

app.post('/api/cobrancas/parcela/:id/prometeu', authMiddleware, async (req, res) => {
  await dbRun(`UPDATE parcelas SET status='prometeu' WHERE id=? AND cobranca_id IN (SELECT id FROM cobrancas WHERE lojista_id=?)`,
    [req.params.id, req.lojista.id]);
  res.json({ ok: true });
});

app.post('/api/cobrancas/parcela/:id/gerar-pix', authMiddleware, async (req, res) => {
  try {
    const parcela = await dbGet(`
      SELECT p.*, c.lojista_id, c.descricao, cli.nome as cliente_nome
      FROM parcelas p
      JOIN cobrancas c ON c.id = p.cobranca_id
      JOIN clientes cli ON cli.id = c.cliente_id
      WHERE p.id = ? AND c.lojista_id = ?
    `, [req.params.id, req.lojista.id]);
    if (!parcela) return res.status(404).json({ erro: 'Parcela não encontrada' });
    const pixData = await gerarPixOpenPix(req.lojista.id, parcela.id, parcela.valor, parcela.descricao, parcela.cliente_nome);
    if (!pixData) return res.status(400).json({ erro: 'Não foi possível gerar PIX. Verifique o App ID da OpenPix nas configurações.' });
    await dbRun('UPDATE parcelas SET pix_id=?, pix_code=?, pix_qr=? WHERE id=?',
      [pixData.pix_id, pixData.pix_code, pixData.pix_qr, parcela.id]);
    res.json(pixData);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/webhook/openpix', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) :
                 (typeof req.body === 'object' && req.body !== null ? req.body : JSON.parse(String(req.body)));
    if (body.event === 'OPENPIX:CHARGE_COMPLETED' && body.charge?.correlationID) {
      const parcelaId = body.charge.correlationID;

      // Marca parcela como paga
      await dbRun("UPDATE parcelas SET status='pago', pago_em=datetime('now') WHERE id=?", [parcelaId]);

      // Busca dados para enviar mensagem de confirmação
      const dados = await dbGet(`
        SELECT p.valor, p.numero, c.total_parcelas,
          c.lojista_id, c.descricao,
          cli.nome as cliente_nome, cli.telefone as cliente_tel,
          l.nome_empresa, l.nome as lojista_nome
        FROM parcelas p
        JOIN cobrancas c ON c.id = p.cobranca_id
        JOIN clientes cli ON cli.id = c.cliente_id
        JOIN lojistas l ON l.id = c.lojista_id
        WHERE p.id = ?
      `, [parcelaId]);

      if (dados?.cliente_tel) {
        const empresa = dados.nome_empresa || dados.lojista_nome || 'nossa empresa';
        const valor = 'R$ ' + Number(dados.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
        const parcela = `${dados.numero}/${dados.total_parcelas}`;
        const msg = `✅ *Pagamento confirmado!*\n\nOlá ${dados.cliente_nome}, recebemos seu pagamento de *${valor}* (parcela ${parcela}) com a *${empresa}*.\n\nObrigado e até logo! 😊`;
        await enviarWhatsApp(dados.lojista_id, dados.cliente_tel, msg);
      }
    }
    res.sendStatus(200);
  } catch { res.sendStatus(200); }
});

// ─── RÉGUA ────────────────────────────────────────────────────────────────────
app.get('/api/regua/config', authMiddleware, async (req, res) => {
  const cfg = await dbGet('SELECT * FROM config WHERE lojista_id=?', [req.lojista.id]);
  res.json(cfg || {});
});

app.put('/api/regua/config', authMiddleware, async (req, res) => {
  const { openpix_app_id, horarios_envio, horarios_ligacao } = req.body;
  const horariosJson = horarios_envio ? JSON.stringify(horarios_envio) : null;
  const horariosLigJson = horarios_ligacao ? JSON.stringify(horarios_ligacao) : null;
  await dbRun(`
    INSERT INTO config (lojista_id, openpix_app_id, horarios_envio, horarios_ligacao)
    VALUES (?,?,?,?)
    ON CONFLICT(lojista_id) DO UPDATE SET
      openpix_app_id=excluded.openpix_app_id,
      horarios_envio=COALESCE(excluded.horarios_envio, horarios_envio),
      horarios_ligacao=COALESCE(excluded.horarios_ligacao, horarios_ligacao)
  `, [req.lojista.id, openpix_app_id || null, horariosJson, horariosLigJson]);
  res.json({ ok: true });
});

app.get('/api/regua', authMiddleware, async (req, res) => {
  const regua = await dbAll('SELECT * FROM regua WHERE lojista_id=? ORDER BY dia_atraso', [req.lojista.id]);
  res.json(regua);
});

app.post('/api/regua', authMiddleware, async (req, res) => {
  try {
    const { dia_atraso, acao_wpp, acao_voz, mensagem_wpp, ativo } = req.body;
    await dbRun('INSERT INTO regua (lojista_id, dia_atraso, acao_wpp, acao_voz, mensagem_wpp, ativo) VALUES (?,?,?,?,?,?)',
      [req.lojista.id, dia_atraso, acao_wpp ? 1 : 0, acao_voz ? 1 : 0, mensagem_wpp, ativo ? 1 : 0]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ erro: 'Já existe uma regra para esse dia de atraso' }); }
});

app.put('/api/regua/:id', authMiddleware, async (req, res) => {
  const { acao_wpp, acao_voz, mensagem_wpp, roteiro_voz, ativo } = req.body;
  await dbRun('UPDATE regua SET acao_wpp=?, acao_voz=?, mensagem_wpp=?, roteiro_voz=?, ativo=? WHERE id=? AND lojista_id=?',
    [acao_wpp ? 1 : 0, acao_voz ? 1 : 0, mensagem_wpp, roteiro_voz || null, ativo ? 1 : 0, req.params.id, req.lojista.id]);
  res.json({ ok: true });
});

app.delete('/api/regua/:id', authMiddleware, async (req, res) => {
  await dbRun('DELETE FROM regua WHERE id=? AND lojista_id=?', [req.params.id, req.lojista.id]);
  res.json({ ok: true });
});

// ─── WHATSAPP ─────────────────────────────────────────────────────────────────
async function enviarWhatsApp(lojista_id, telefone, mensagem) {
  const cfg = await dbGet('SELECT * FROM config WHERE lojista_id=?', [lojista_id]);
  const url  = cfg?.evolution_url  || EVOLUTION_URL;
  const key  = cfg?.evolution_key  || EVOLUTION_KEY;
  const inst = cfg?.evolution_inst || `cobrarai_${lojista_id.replace(/-/g,'').substring(0,12)}`;
  if (!url || !key) { console.error('[WPP] Config incompleta — EVOLUTION_URL ou KEY ausente'); return false; }
  const tel = telefone.replace(/\D/g, '');
  const numero = tel.startsWith('55') ? tel : '55' + tel;
  console.log(`[WPP] Enviando para ${numero} via ${inst}`);
  try {
    const r = await fetch(`${url}/message/sendText/${inst}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({ number: numero, textMessage: { text: mensagem } }),
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      console.error(`[WPP] Falha ${r.status}:`, errBody.substring(0, 200));
      return false;
    }
    console.log('[WPP] Enviado com sucesso para', numero);
    return true;
  } catch (e) { console.error('[WPP] Erro de rede:', e.message); return false; }
}

function montarMensagem(template, dados) {
  return template
    .replace(/{nome}/g, dados.nome || '')
    .replace(/{empresa}/g, dados.empresa || '')
    .replace(/{valor}/g, dados.valor ? 'R$ ' + Number(dados.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '')
    .replace(/{vencimento}/g, dados.vencimento || '')
    .replace(/{link}/g, dados.link || '')
    .replace(/{parcela}/g, dados.parcela || '');
}

// ─── VAPI: LIGAÇÃO IA ─────────────────────────────────────────────────────────
async function enviarLigacaoVAPI(lojista_id, telefone, roteiro) {
  const apiKey      = VAPI_KEY;
  const assistantId = VAPI_ASSISTANT_ID;
  const phoneId     = VAPI_PHONE_ID;
  if (!apiKey || !assistantId || !phoneId) return { ok: false, erro: 'VAPI não configurado no servidor' };

  const tel = telefone.replace(/\D/g, '');
  const numero = tel.startsWith('55') ? '+' + tel : '+55' + tel;

  try {
    const r = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        assistantId,
        phoneNumberId: phoneId,
        customer: { number: numero },
        assistantOverrides: {
          firstMessage: roteiro,
        },
      }),
    });
    const data = await r.json();
    if (!r.ok) return { ok: false, erro: data?.message || 'Erro VAPI' };
    return { ok: true, call_id: data.id };
  } catch (e) {
    console.error('[VAPI] Erro:', e.message);
    return { ok: false, erro: e.message };
  }
}

// ─── CRON: RÉGUA AUTOMÁTICA ───────────────────────────────────────────────────
async function rodarRegua(lojista_id_filtro = null, tipo = null) {
  console.log('[RÉGUA] Iniciando:', new Date().toISOString(), lojista_id_filtro ? `lojista=${lojista_id_filtro}` : 'todos', tipo ? `tipo=${tipo}` : '');
  const parcelasAlvo = await dbAll(`
    SELECT p.id, p.numero, p.valor, p.vencimento, p.status, p.pix_code,
      c.id as cob_id, c.lojista_id, c.descricao, c.total_parcelas,
      cli.nome as cliente_nome, cli.telefone as cliente_tel
    FROM parcelas p
    JOIN cobrancas c ON c.id = p.cobranca_id
    JOIN clientes cli ON cli.id = c.cliente_id
    WHERE p.status IN ('pendente','prometeu') AND p.vencimento <= date('now')
    ${lojista_id_filtro ? 'AND c.lojista_id = ?' : ''}
  `, lojista_id_filtro ? [lojista_id_filtro] : []);

  console.log(`[RÉGUA] ${parcelasAlvo.length} parcelas em atraso encontradas`);
  let enviados = 0, erros = 0;
  const empresaCache = {};
  for (const p of parcelasAlvo) {
    if (!empresaCache[p.lojista_id]) {
      const l = await dbGet('SELECT nome_empresa, nome FROM lojistas WHERE id=?', [p.lojista_id]);
      empresaCache[p.lojista_id] = l?.nome_empresa || l?.nome || '';
    }
    const atraso = diasAtraso(p.vencimento);
    console.log(`[RÉGUA] Parcela ${p.id} — cliente: ${p.cliente_nome}, atraso: ${atraso} dias, tel: ${p.cliente_tel}`);
    const regras = await dbAll('SELECT * FROM regua WHERE lojista_id=? AND dia_atraso=? AND ativo=1', [p.lojista_id, atraso]);
    console.log(`[RÉGUA] Regras ativas para dia ${atraso}: ${regras.length}`);
    for (const regra of regras) {
      const dados = {
        nome: p.cliente_nome, valor: p.valor, vencimento: p.vencimento,
        empresa: empresaCache[p.lojista_id],
        link: p.pix_code ? `https://cobrar.ai/pix/${p.id}` : '',
        parcela: `${p.numero}/${p.total_parcelas}`,
      };

      // WhatsApp
      if (regra.acao_wpp && p.cliente_tel && regra.mensagem_wpp && (!tipo || tipo === 'wpp')) {
        const jaEnviouWpp = await dbGet(`SELECT id FROM disparos WHERE parcela_id=? AND dia_atraso=? AND tipo='wpp' AND status='ok' AND strftime('%Y-%m-%d %H', enviado_em)=strftime('%Y-%m-%d %H', 'now')`, [p.id, atraso]);
        if (!jaEnviouWpp) {
          const msg = montarMensagem(regra.mensagem_wpp, dados);
          const ok = await enviarWhatsApp(p.lojista_id, p.cliente_tel, msg);
          await dbRun('INSERT INTO disparos (parcela_id, lojista_id, tipo, dia_atraso, status, erro) VALUES (?,?,?,?,?,?)',
            [p.id, p.lojista_id, 'wpp', atraso, ok ? 'ok' : 'erro', ok ? null : 'Falha no envio']);
          if (ok) enviados++; else erros++;
        }
      }

      // Ligação IA (VAPI)
      if (regra.acao_voz && p.cliente_tel && regra.roteiro_voz && (!tipo || tipo === 'voz')) {
        const jaLigou = await dbGet(`SELECT id FROM disparos WHERE parcela_id=? AND dia_atraso=? AND tipo='voz' AND status='ok' AND strftime('%Y-%m-%d %H', enviado_em)=strftime('%Y-%m-%d %H', 'now')`, [p.id, atraso]);
        if (!jaLigou) {
          const roteiro = montarMensagem(regra.roteiro_voz, dados);
          const res = await enviarLigacaoVAPI(p.lojista_id, p.cliente_tel, roteiro);
          await dbRun('INSERT INTO disparos (parcela_id, lojista_id, tipo, dia_atraso, status, erro) VALUES (?,?,?,?,?,?)',
            [p.id, p.lojista_id, 'voz', atraso, res.ok ? 'ok' : 'erro', res.ok ? null : res.erro]);
          if (res.ok) enviados++; else erros++;
        }
      }
    }
  }
  console.log(`[RÉGUA] Enviados: ${enviados}, Erros: ${erros}`);
}

function parseHorarios(json, fallback = []) {
  try {
    return JSON.parse(json || 'null')
      ?.filter(h => h !== null && h !== undefined)
      ?.map(h => typeof h === 'number' ? `${String(h).padStart(2,'0')}:00` : h)
      ?.filter(h => /^\d{2}:\d{2}$/.test(h)) || fallback;
  } catch { return fallback; }
}

// A cada minuto verifica horários de WPP e ligação separadamente (BRT = UTC-3)
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const totalMin = (now.getUTCHours() * 60 + now.getUTCMinutes() - 180 + 1440) % 1440;
  const brtH = String(Math.floor(totalMin / 60)).padStart(2, '0');
  const brtM = String(totalMin % 60).padStart(2, '0');
  const timeStr = `${brtH}:${brtM}`;

  const configs = await dbAll('SELECT lojista_id, horarios_envio, horarios_ligacao FROM config');
  for (const cfg of configs) {
    const horariosWpp = parseHorarios(cfg.horarios_envio, ['08:00']);
    const horariosVoz = parseHorarios(cfg.horarios_ligacao, []);
    const dispWpp = horariosWpp.includes(timeStr);
    const dispVoz = horariosVoz.includes(timeStr);
    if (dispWpp && dispVoz) {
      console.log(`[CRON] ${timeStr} — WPP+Voz lojista ${cfg.lojista_id}`);
      await rodarRegua(cfg.lojista_id, null);
    } else if (dispWpp) {
      console.log(`[CRON] ${timeStr} — WPP lojista ${cfg.lojista_id}`);
      await rodarRegua(cfg.lojista_id, 'wpp');
    } else if (dispVoz) {
      console.log(`[CRON] ${timeStr} — Voz lojista ${cfg.lojista_id}`);
      await rodarRegua(cfg.lojista_id, 'voz');
    }
  }
});

app.post('/api/regua/disparar-agora', authMiddleware, async (req, res) => {
  const { tipo } = req.body;
  await rodarRegua(req.lojista.id, tipo || null);
  res.json({ ok: true, mensagem: 'Régua executada' });
});

app.get('/api/disparos', authMiddleware, async (req, res) => {
  const disparos = await dbAll(`
    SELECT d.*, p.vencimento, cli.nome as cliente_nome
    FROM disparos d
    JOIN parcelas p ON p.id = d.parcela_id
    JOIN cobrancas c ON c.id = p.cobranca_id
    JOIN clientes cli ON cli.id = c.cliente_id
    WHERE d.lojista_id=? ORDER BY d.enviado_em DESC LIMIT 100
  `, [req.lojista.id]);
  res.json(disparos);
});

// ─── WHATSAPP MULTI-TENANT (cada lojista = instância própria) ─────────────────
async function getEvolutionCfg(lojista_id) {
  const cfg = await dbGet('SELECT * FROM config WHERE lojista_id=?', [lojista_id]);
  const url = cfg?.evolution_url || EVOLUTION_URL;
  const key = cfg?.evolution_key || EVOLUTION_KEY;
  const inst = cfg?.evolution_inst || `cobrarai_${lojista_id.replace(/-/g,'').substring(0,12)}`;
  return { url, key, inst };
}

app.post('/api/whatsapp/conectar', authMiddleware, async (req, res) => {
  try {
    const { url, key, inst } = await getEvolutionCfg(req.lojista.id);
    if (!url || !key) return res.status(400).json({ erro: 'Configure a URL e Key do Evolution no .env do servidor.' });

    // Salva instância na config do lojista
    await dbRun(`INSERT INTO config (lojista_id, evolution_url, evolution_key, evolution_inst)
      VALUES (?,?,?,?) ON CONFLICT(lojista_id) DO UPDATE SET
      evolution_url=excluded.evolution_url, evolution_key=excluded.evolution_key, evolution_inst=excluded.evolution_inst`,
      [req.lojista.id, url, key, inst]);

    // Cria instância (ignora erro se já existir)
    await fetch(`${url}/instance/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({ instanceName: inst, qrcode: true }),
    }).catch(() => {});

    // Busca QR Code
    const r = await fetch(`${url}/instance/connect/${inst}`, { headers: { apikey: key } });
    const d = await r.json();

    if (d.code) return res.json({ qr: d.code, instancia: inst });
    if (d.instance?.state === 'open') return res.json({ conectado: true, instancia: inst });
    res.status(400).json({ erro: 'Não foi possível gerar QR Code. Tente novamente.' });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/whatsapp/status', authMiddleware, async (req, res) => {
  try {
    const { url, key, inst } = await getEvolutionCfg(req.lojista.id);
    if (!url || !key) return res.json({ status: 'nao_configurado' });
    const r = await fetch(`${url}/instance/connectionState/${inst}`, { headers: { apikey: key } });
    const d = await r.json();
    res.json({ status: d.instance?.state || d.state || 'desconectado', instancia: inst });
  } catch { res.json({ status: 'desconectado' }); }
});

app.post('/api/whatsapp/desconectar', authMiddleware, async (req, res) => {
  try {
    const { url, key, inst } = await getEvolutionCfg(req.lojista.id);
    if (url && key) await fetch(`${url}/instance/logout/${inst}`, { method: 'DELETE', headers: { apikey: key } }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── STATUS ───────────────────────────────────────────────────────────────────
app.get('/api/status', authMiddleware, async (req, res) => {
  try {
    const cfg = await dbGet('SELECT * FROM config WHERE lojista_id=?', [req.lojista.id]);
    const url  = cfg?.evolution_url  || EVOLUTION_URL;
    const key  = cfg?.evolution_key  || EVOLUTION_KEY;
    const inst = cfg?.evolution_inst || `cobrarai_${req.lojista.id.replace(/-/g,'').substring(0,12)}`;

    let wppStatus = 'desconectado';
    if (url && key) {
      try {
        const r = await fetch(`${url}/instance/connectionState/${inst}`, { headers: { apikey: key } });
        const d = await r.json();
        wppStatus = d.instance?.state || d.state || 'desconectado';
      } catch { wppStatus = 'erro'; }
    }

    const vapiOk = !!(VAPI_KEY && VAPI_ASSISTANT_ID && VAPI_PHONE_ID);
    res.json({ wpp: wppStatus, vapi: vapiOk });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', versao: '1.1.0', hora: new Date().toISOString() });
});

// ─── ADMIN ────────────────────────────────────────────────────────────────────
const ADMIN_EMAIL = 'gabrielgomes251@gmail.com';

async function adminMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ erro: 'Token necessário' });
  try {
    const payload = jwt.verify(auth.replace('Bearer ', ''), JWT_SECRET);
    if (payload.email === ADMIN_EMAIL) { req.admin = payload; return next(); }
    const colab = await dbGet('SELECT id FROM admin_colaboradores WHERE email=?', [payload.email]);
    if (colab) { req.admin = payload; return next(); }
    return res.status(403).json({ erro: 'Acesso restrito' });
  } catch { res.status(401).json({ erro: 'Token inválido' }); }
}

app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  try {
    const lojistas  = await dbGet('SELECT COUNT(*) as total FROM lojistas');
    const clientes  = await dbGet('SELECT COUNT(*) as total FROM clientes');
    const cobrancas = await dbGet('SELECT COUNT(*) as total FROM cobrancas');
    const parcelas  = await dbGet('SELECT COUNT(*) as total FROM parcelas');
    const disparos  = await dbGet("SELECT COUNT(*) as total FROM disparos WHERE status='ok'");
    const receita   = await dbGet("SELECT COALESCE(SUM(valor),0) as total FROM parcelas WHERE status='pago'");
    const atraso    = await dbGet("SELECT COUNT(*) as total FROM parcelas WHERE status IN ('pendente','prometeu') AND vencimento < date('now')");
    res.json({ lojistas: lojistas.total, clientes: clientes.total, cobrancas: cobrancas.total, parcelas: parcelas.total, disparos: disparos.total, receita: receita.total, atraso: atraso.total });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/admin/lojistas', adminMiddleware, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT l.id, l.nome, l.nome_empresa, l.email, l.telefone, l.criado_em,
        COUNT(DISTINCT c.id) as total_clientes,
        COUNT(DISTINCT cob.id) as total_cobrancas,
        COUNT(DISTINCT CASE WHEN d.status='ok' THEN d.id END) as total_disparos
      FROM lojistas l
      LEFT JOIN clientes c ON c.lojista_id = l.id
      LEFT JOIN cobrancas cob ON cob.lojista_id = l.id
      LEFT JOIN disparos d ON d.lojista_id = l.id
      GROUP BY l.id ORDER BY l.criado_em DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/admin/lojistas/:id', adminMiddleware, async (req, res) => {
  try {
    const { nome, nome_empresa, email, telefone } = req.body;
    await dbRun('UPDATE lojistas SET nome=?, nome_empresa=?, email=?, telefone=? WHERE id=?', [nome, nome_empresa||null, email, telefone||null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/admin/lojistas/:id', adminMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    if (id === (await dbGet('SELECT id FROM lojistas WHERE email=?', [ADMIN_EMAIL]))?.id)
      return res.status(400).json({ erro: 'Não é possível excluir o administrador principal' });
    await dbRun('DELETE FROM disparos WHERE lojista_id=?', [id]);
    const cobs = await dbAll('SELECT id FROM cobrancas WHERE lojista_id=?', [id]);
    for (const c of cobs) await dbRun('DELETE FROM parcelas WHERE cobranca_id=?', [c.id]);
    await dbRun('DELETE FROM cobrancas WHERE lojista_id=?', [id]);
    await dbRun('DELETE FROM clientes WHERE lojista_id=?', [id]);
    await dbRun('DELETE FROM regua WHERE lojista_id=?', [id]);
    await dbRun('DELETE FROM config WHERE lojista_id=?', [id]);
    await dbRun('DELETE FROM lojistas WHERE id=?', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/admin/clientes', adminMiddleware, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT c.*, l.nome as lojista_nome, l.nome_empresa,
        COUNT(DISTINCT cob.id) as total_cobrancas,
        COUNT(CASE WHEN p.status!='pago' AND p.vencimento < date('now') THEN 1 END) as parcelas_atrasadas,
        COALESCE(SUM(CASE WHEN p.status!='pago' AND p.vencimento < date('now') THEN p.valor END),0) as valor_em_atraso
      FROM clientes c
      JOIN lojistas l ON l.id = c.lojista_id
      LEFT JOIN cobrancas cob ON cob.cliente_id = c.id
      LEFT JOIN parcelas p ON p.cobranca_id = cob.id
      GROUP BY c.id ORDER BY c.criado_em DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/admin/cobrancas', adminMiddleware, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT cob.*, l.nome as lojista_nome, l.nome_empresa, cli.nome as cliente_nome, cli.telefone as cliente_tel,
        COUNT(p.id) as total_parcelas_real,
        COUNT(CASE WHEN p.status='pago' THEN 1 END) as pagas,
        COUNT(CASE WHEN p.status!='pago' AND p.vencimento < date('now') THEN 1 END) as atrasadas
      FROM cobrancas cob
      JOIN lojistas l ON l.id = cob.lojista_id
      JOIN clientes cli ON cli.id = cob.cliente_id
      LEFT JOIN parcelas p ON p.cobranca_id = cob.id
      GROUP BY cob.id ORDER BY cob.criado_em DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/admin/disparos', adminMiddleware, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT d.*, l.nome as lojista_nome, l.nome_empresa
      FROM disparos d
      JOIN lojistas l ON l.id = d.lojista_id
      ORDER BY d.enviado_em DESC LIMIT 500
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/admin/colaboradores', adminMiddleware, async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM admin_colaboradores ORDER BY criado_em DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/admin/colaboradores', adminMiddleware, async (req, res) => {
  try {
    if (req.admin.email !== ADMIN_EMAIL) return res.status(403).json({ erro: 'Apenas o administrador principal pode adicionar colaboradores' });
    const { nome, email } = req.body;
    if (!email) return res.status(400).json({ erro: 'Email obrigatório' });
    const id = crypto.randomUUID();
    await dbRun('INSERT INTO admin_colaboradores (id, nome, email) VALUES (?,?,?)', [id, nome||email, email]);
    res.json({ ok: true, id });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ erro: 'Este email já é colaborador' });
    res.status(500).json({ erro: e.message });
  }
});

app.delete('/api/admin/colaboradores/:id', adminMiddleware, async (req, res) => {
  try {
    if (req.admin.email !== ADMIN_EMAIL) return res.status(403).json({ erro: 'Apenas o administrador principal pode remover colaboradores' });
    await dbRun('DELETE FROM admin_colaboradores WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─── START ────────────────────────────────────────────────────────────────────
iniciarBanco().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 CobrarAí rodando na porta ${PORT}`);
    console.log(`   Régua automática: todo dia às 08h (Brasília)`);
  });
}).catch(e => {
  console.error('Erro ao iniciar banco:', e.message);
  process.exit(1);
});
