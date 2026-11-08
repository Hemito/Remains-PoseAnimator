// MCP server (stdio, JSON-RPC 2.0, no external packages) for the pony pose atlas / animator.
// Every tool is forwarded to Tools/PoseAnimator/server.mjs, which runs it inside the page (the user's open page, else a
// hidden headless one). The server is started on demand and keeps running for the user's page.
// Register: .mcp.json in the repository root (Claude Code); for Codex: command "node", args ["Tools/PoseAnimator/mcp.mjs"].
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.POSE_ANIMATOR_PORT || 8770), BASE = `http://127.0.0.1:${PORT}`;
const GUIDE = fs.readFileSync(path.join(here, 'GUIDE.md'), 'utf8');
const err = (...a) => process.stderr.write(a.join(' ') + '\n');
let session = (process.env.POSE_ANIMATOR_SESSION || 'agent').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'agent';

const P = (type, description, extra = {}) => ({type, description, ...extra});
const chain = P('string', 'Цепочка: hindNear, hindFar, frontNear, frontFar, head, tail', {enum: ['hindNear', 'hindFar', 'frontNear', 'frontFar', 'head', 'tail']});
const socket = P('string', 'Часть цепочки, например hindLowerNear (список — в describe.chains[].sockets)');
const point = P('array', 'Точка [x, y]', {items: {type: 'number'}, minItems: 2, maxItems: 2});
const tool = (name, description, properties = {}, required = []) => ({name, description, inputSchema: {type: 'object', properties, required, additionalProperties: false}});
const TOOLS = [
  tool('guide', 'Полная инструкция: как устроены цепочки и атлас, порядок работы над позой и анимацией, правила.'),
  tool('describe', 'Цепочки, группы движений, текущая поза (концы цепочек, смесь, выход за край), сохранённые позы и анимации.'),
  tool('render', 'Картинка текущей позы (PNG) или листа кадров анимации. Смотри её после каждого существенного шага.', {
    outfit: P('string', 'bare — без костюма, suit — антирад, both — рядом', {enum: ['bare', 'suit', 'both']}),
    size: P('integer', 'Сторона картинки в пикселях, 160–1024 (по умолчанию 520)'),
    handles: P('boolean', 'Подписать концы цепочек (по умолчанию да)'),
    preview: P('boolean', 'Наложить текущую мимику и ожидание только на картинку (по умолчанию нет, кадры анимации не меняются)'),
    frames: P('array', 'Номера кадров текущей анимации для листа (с 0); без них — текущая поза', {items: {type: 'integer'}})}),
  tool('set_preview', 'Только предпросмотр: мимика, моргание и движения ожидания из игрового банка. Не меняет позу, ключи или выгрузку; render с preview:true показывает этот слой.', {
    expression: P('string', 'Выражение глаз', {enum:['neutral','alert','closed','dead']}), blink: P('boolean', 'Моргание (только neutral/alert)'),
    idle: P('string', 'Клип ожидания или пустая строка для выключения', {enum:['','free1','free2','free3']}),
    frame: P('integer', 'Кадр выбранного ожидания с нуля'), playing: P('boolean', 'Воспроизводить предпросмотр (по умолчанию нет)')}),
  tool('list_states', 'Состояния цепочки из атласа: id, группа, конец цепочки, отметка; с near — ближайшие к точке.', {
    chain, group: P('string', 'Только эта группа (id из describe.groups)'), near: point, limit: P('integer', 'Сколько вернуть (по умолчанию 20)')}, ['chain']),
  tool('set_chain_end', 'Поставить конец цепочки в точку; форма цепочки смешивается из соседних состояний атласа.', {
    chain, x: P('number', 'x'), y: P('number', 'y'), space: P('string', 'torso — относительно туловища (по умолчанию), world — в мире', {enum: ['torso', 'world']})}, ['chain', 'x', 'y']),
  tool('set_state', 'Поставить цепочке точное исходное (или своё) состояние по id из list_states.', {chain, state: P('string', 'id состояния, например walk/11')}, ['chain', 'state']),
  tool('reset', 'Сбросить одну цепочку (с её правками) или, без параметров, всю позу и корпус в стойку.', {chain}),
  tool('set_body', 'Наклонить (градусы, + поднимает перед) и сдвинуть корпус вокруг точки поворота.', {
    angle: P('number', 'Наклон, градусы'), x: P('number', 'Сдвиг по x'), y: P('number', 'Сдвиг по y'),
    pivot: P('string', 'Точка поворота', {enum: ['hips', 'center', 'shoulders']}), floor: P('boolean', 'После изменения опустить/поднять пони так, чтобы нижняя точка рисунка легла на пол'), pin: P('boolean', 'Копыта, стоящие на полу, держать на месте в мире (по умолчанию да); копыта в воздухе движутся с корпусом')}),
  tool('get_part', 'Три точки части (сейчас и в стойке), её рисунок и доступные варианты рисунка.', {socket}, ['socket']),
  tool('fine_edit', 'Тонкая правка одной части поверх состояния цепочки: смещение/поворот/масштаб вокруг её сустава (или pivot), либо три точки целиком; clear снимает правку. Ответ предупреждает, если часть сжата или растянута сильнее, чем рисует оригинал.', {
    socket, translate: point, rotate: P('number', 'Поворот, градусы (+ против часовой)'), scale: P('number', 'Масштаб'), pivot: point,
    points: P('array', 'Три точки [[x,y],[x,y],[x,y]] относительно туловища', {items: point, minItems: 3, maxItems: 3}), clear: P('boolean', 'Снять правку')}, ['socket']),
  tool('rotate_parts', 'Повернуть, масштабировать и сдвинуть несколько частей вместе вокруг одной точки (по умолчанию — сустав первой части): голову с гривой, всю ногу от бедра.', {
    sockets: P('array', 'Части, например ["head","mane"] или ["hindUpperNear","hindLowerNear"]', {items: {type: 'string'}, minItems: 1}),
    deg: P('number', 'Поворот, градусы (+ против часовой)'), scale: P('number', 'Масштаб'), translate: point, pivot: point}, ['sockets']),
  tool('set_drawing','Выбрать вариант рисунка части (из get_part.drawings); без drawing — вернуть выбор атласа.', {socket, drawing: P('string', 'id рисунка')}, ['socket']),
  tool('set_groups', 'Выключить или включить группы движений в смешивании.', {
    hide: P('array', 'id групп выключить', {items: {type: 'string'}}), show: P('array', 'id групп включить', {items: {type: 'string'}})}),
  tool('set_mix', 'Режим смешивания: все показанные группы или только отмеченные «годится»; предел пустот (м); что делать за краем примеров.', {
    mode: P('string', 'visible или good', {enum: ['visible', 'good']}), edge: P('number', 'Не смешивать через пустоты длиннее, м: 0.08, 0.12, 0.2, 99'),
    outside: P('string', 'За краем примеров: clamp — прижать конец к краю; swing — взять форму с края и довернуть цепочку вокруг корня к точке', {enum: ['clamp', 'swing']})}),
  tool('mark_state', 'Отметить состояние «годится» (good) / «плохо» (bad) или снять отметку (без mark). Это решение пользователя.', {
    chain, state: P('string', 'id состояния'), mark: P('string', 'good или bad', {enum: ['good', 'bad']})}, ['chain', 'state']),
  tool('save_pose', 'Сохранить текущую позу под именем (в проект).', {name: P('string', 'Имя позы')}, ['name']),
  tool('load_pose', 'Загрузить сохранённую позу.', {name: P('string', 'Имя позы')}, ['name']),
  tool('add_to_atlas', 'Изменённые цепочки текущей позы сделать своими состояниями атласа (группа «Свои позы»).'),
  tool('new_clip', 'Новая анимация и сделать её текущей.', {name: P('string', 'Имя латиницей, например sit-down'), length: P('integer', 'Кадров (2–600)'), fps: P('integer', 'Кадров в секунду')}, ['name']),
  tool('select_clip', 'Сделать анимацию текущей.', {clip: P('string', 'id анимации')}, ['clip']),
  tool('set_length', 'Число кадров текущей анимации.', {length: P('integer', 'Кадров (2–600)')}, ['length']),
  tool('goto_frame', 'Перейти к кадру (с 0); поза между ключами собирается из соседних ключей.', {frame: P('integer', 'Кадр с 0')}, ['frame']),
  tool('set_key', 'Поставить ключ из текущей позы в кадр (по умолчанию текущий).', {frame: P('integer', 'Кадр с 0')}),
  tool('remove_key', 'Убрать ключ.', {frame: P('integer', 'Кадр с 0')}, ['frame']),
  tool('list_keys', 'Ключи текущей анимации.'),
  tool('save_clip', 'Сохранить текущую анимацию в проект вместе со всеми кадрами (17 частей на кадр).'),
];

async function serverUp() { try { return (await fetch(BASE + '/api/status')).ok; } catch { return false; } }
async function ensureServer() {
  if (await serverUp()) return;
  // The detached server logs to a temp file (no window, nothing on the MCP channel).
  const logFile = fs.openSync(path.join(os.tmpdir(), 'remains-pose-animator.log'), 'a');
  const child = spawn(process.execPath, [path.join(here, 'server.mjs')], {detached: true, windowsHide: true, stdio: ['ignore', logFile, logFile], env: process.env});
  child.unref();
  for (let i = 0; i < 50; i++) { await new Promise(r => setTimeout(r, 200)); if (await serverUp()) return; }
  throw new Error('Сервер аниматора не запустился на порту ' + PORT);
}
async function call(name, args) {
  if (name === 'guide') return {content: [{type: 'text', text: GUIDE}]};
  await ensureServer();
  const response = await fetch(BASE + '/api/command', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({session, name, args: args || {}})});
  const result = await response.json();
  if (!response.ok || result?.error) return {isError: true, content: [{type: 'text', text: 'Ошибка: ' + (result?.error || response.status)}]};
  const content = [];
  if (result.png) {
    content.push({type: 'image', mimeType: 'image/png', data: result.png.split(',', 2)[1]});
    delete result.png;
  }
  content.push({type: 'text', text: JSON.stringify(result, null, 1) + (name === 'describe' ? `\nТвой сеанс «${session}». Пользователь видит его на ${BASE}/?session=${session}` : '')});
  return {content};
}

function write(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
async function handle(message) {
  const {id, method, params} = message;
  if (id === undefined) return;   // notifications (initialized, cancelled) need no reply
  try {
    // Each agent gets its own live pose: the session is the client's name unless POSE_ANIMATOR_SESSION is set.
    if (method === 'initialize') session = (process.env.POSE_ANIMATOR_SESSION || params?.clientInfo?.name || 'agent').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'agent';
    if (method === 'initialize') return write({jsonrpc: '2.0', id, result: {protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: {tools: {listChanged: false}}, serverInfo: {name: 'pony-animator', version: '1.0.0'}, instructions: GUIDE}});
    if (method === 'ping') return write({jsonrpc: '2.0', id, result: {}});
    if (method === 'tools/list') return write({jsonrpc: '2.0', id, result: {tools: TOOLS}});
    if (method === 'tools/call') {
      if (!TOOLS.some(t => t.name === params?.name)) return write({jsonrpc: '2.0', id, error: {code: -32602, message: 'Нет инструмента ' + params?.name}});
      return write({jsonrpc: '2.0', id, result: await call(params.name, params.arguments)});
    }
    write({jsonrpc: '2.0', id, error: {code: -32601, message: 'Метод не поддерживается: ' + method}});
  } catch (error) {
    err('pony-animator:', error.stack || error.message);
    write({jsonrpc: '2.0', id, result: {isError: true, content: [{type: 'text', text: 'Ошибка: ' + error.message}]}});
  }
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let line; (line = buffer.indexOf('\n')) >= 0;) {
    const text = buffer.slice(0, line).trim(); buffer = buffer.slice(line + 1);
    if (!text) continue;
    let message; try { message = JSON.parse(text); } catch { write({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Неверный JSON'}}); continue; }
    handle(message);
  }
});
