const express = require('express'), Database = require('better-sqlite3'), crypto = require('crypto');
const db = new Database(process.env.DB_PATH || 'data.db');
db.exec(`
create table if not exists groups(id integer primary key, name text, subject text, days text, time text);
create table if not exists students(id integer primary key, first text, last text, address text, phone text, phone2 text,
  group_id integer, username text unique, pass text, ref_code text, referred_by integer, created text);
create table if not exists payments(id integer primary key, student_id integer, month text, amount integer, created text);
create table if not exists attendance(student_id integer, date text, status text, reason text, primary key(student_id,date));
create table if not exists grades(id integer primary key, student_id integer, date text, score integer);
create table if not exists coin_log(id integer primary key, student_id integer, kind text, coins integer, date text, note text);
create table if not exists shop(id integer primary key, name text, price integer);
create table if not exists applications(id integer primary key, first text, last text, address text, phone text, phone2 text, ref_code text, status text default 'yangi', created text);
create table if not exists tg(chat_id text primary key, student_id integer);
`);
const today = () => new Date().toISOString().slice(0, 10);
const hash = (p, salt = crypto.randomBytes(8).toString('hex')) => salt + ':' + crypto.scryptSync(p, salt, 32).toString('hex');
const check = (p, st) => { const [s] = st.split(':'); return hash(p, s) === st; };
const rnd = n => Array.from({ length: n }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[crypto.randomInt(31)]).join('');
const newCode = () => { let c; do c = String(crypto.randomInt(100000, 999999)); while (db.prepare('select 1 from students where ref_code=?').get(c)); return c; };
const addCoin = (sid, kind, coins, note = '', date = today()) => db.prepare('insert into coin_log(student_id,kind,coins,date,note) values(?,?,?,?,?)').run(sid, kind, coins, date, note);
const once = (sid, kind, date) => !db.prepare('select 1 from coin_log where student_id=? and kind=? and date=?').get(sid, kind, date);

function makeStudent(a, group_id) {
  let base = (a.first + '.' + a.last).toLowerCase().replace(/[^a-z0-9.]/g, '') || 'oquvchi', u = base, i = 1;
  while (db.prepare('select 1 from students where username=?').get(u)) u = base + (++i);
  const pass = rnd(6);
  const id = db.prepare('insert into students(first,last,address,phone,phone2,group_id,username,pass,ref_code,created) values(?,?,?,?,?,?,?,?,?,?)')
    .run(a.first, a.last, a.address, a.phone, a.phone2, group_id, u, hash(pass), newCode(), today()).lastInsertRowid;
  return { id, username: u, password: pass };
}

function stats(sid) {
  const s = db.prepare('select s.id,s.first,s.last,s.username,s.ref_code,s.group_id,g.name gname,g.subject,g.days,g.time from students s left join groups g on g.id=s.group_id where s.id=?').get(sid);
  if (!s) return null;
  const logs = db.prepare('select * from coin_log where student_id=?').all(sid);
  const grades = db.prepare('select date,score from grades where student_id=?').all(sid);
  const att = db.prepare("select date from attendance where student_id=? and status='keldi'").all(sid);
  const months = [...new Set([...logs, ...grades, ...att].map(x => x.date.slice(0, 7)))].sort();
  const inM = (arr, m) => arr.filter(x => x.date.slice(0, 7) === m);
  const series = {
    labels: months,
    avg: months.map(m => { const g = inM(grades, m); return g.length ? Math.round(g.reduce((a, b) => a + b.score, 0) / g.length) : 0; }),
    coins: months.map(m => inM(logs, m).filter(x => x.coins > 0).reduce((a, b) => a + b.coins, 0)),
    homework: months.map(m => inM(grades, m).length),
    attend: months.map(m => inM(att, m).length),
    active: months.map(m => inM(logs, m).filter(x => x.kind === 'active').length),
  };
  const earned = logs.filter(x => x.coins > 0).reduce((a, b) => a + b.coins, 0);
  return {
    ...s, balance: logs.reduce((a, b) => a + b.coins, 0), earned,
    avg: grades.length ? Math.round(grades.reduce((a, b) => a + b.score, 0) / grades.length) : 0,
    homework: grades.length, attend: att.length, active: logs.filter(x => x.kind === 'active').length,
    rank: rankOf(sid, s.subject), series,
  };
}
const ranking = subject => db.prepare(`select s.id,s.first,s.last,g.name gname, coalesce(sum(case when c.coins>0 then c.coins end),0) e
  from students s join groups g on g.id=s.group_id left join coin_log c on c.student_id=s.id where g.subject=? group by s.id order by e desc, s.id`).all(subject);
const rankOf = (sid, subject) => { if (!subject) return null; const r = ranking(subject); return { place: r.findIndex(x => x.id === sid) + 1, total: r.length }; };

const app = express();
app.use(express.json());
app.use(express.static('public'));
const sessions = new Map();
const ADMIN = { u: process.env.ADMIN_USER || 'admin', p: process.env.ADMIN_PASS || 'admin123' };
app.post('/api/login', (req, res) => {
  const { username, password } = req.body, tk = crypto.randomBytes(24).toString('hex');
  if (username === ADMIN.u && password === ADMIN.p) { sessions.set(tk, { role: 'admin' }); return res.json({ token: tk, role: 'admin' }); }
  const s = db.prepare('select id,pass from students where username=?').get(String(username || '').toLowerCase());
  if (!s || !check(password || '', s.pass)) return res.status(401).json({ error: "Login yoki parol noto'g'ri" });
  sessions.set(tk, { role: 'student', sid: s.id }); res.json({ token: tk, role: 'student' });
});
const auth = role => (req, res, next) => {
  const s = sessions.get((req.headers.authorization || '').replace('Bearer ', ''));
  if (!s || (role && s.role !== role)) return res.status(401).json({ error: 'Kirish kerak' });
  req.s = s; next();
};
app.post('/api/apply', (req, res) => {
  const a = req.body;
  if (!a.first || !a.last || !a.address || !a.phone || !a.phone2) return res.status(400).json({ error: "Barcha maydonlarni to'ldiring" });
  db.prepare('insert into applications(first,last,address,phone,phone2,ref_code,created) values(?,?,?,?,?,?,?)').run(a.first, a.last, a.address, a.phone, a.phone2, a.ref_code || '', today());
  res.json({ ok: true });
});
app.get('/api/subjects', (q, r) => r.json(db.prepare('select distinct subject from groups').all().map(x => x.subject)));
app.get('/api/top', (req, res) => {
  const r = ranking(req.query.subject || '');
  res.json({ total: r.length, top: r.slice(0, 20).map((x, i) => ({ place: i + 1, name: x.first + ' ' + x.last, group: x.gname, coins: x.e })) });
});

// ---- ADMIN ----
const A = auth('admin');
app.get('/api/admin/overview', A, (q, res) => res.json({
  groups: db.prepare('select g.*,(select count(*) from students where group_id=g.id) n from groups g').all(),
  students: db.prepare(`select s.id,s.first,s.last,s.phone,s.phone2,s.address,s.username,s.group_id,g.name gname,
    (select coalesce(sum(coins),0) from coin_log where student_id=s.id) coins from students s left join groups g on g.id=s.group_id order by s.id desc`).all(),
  apps: db.prepare("select * from applications where status='yangi' order by id desc").all(),
  shop: db.prepare('select * from shop').all(),
  orders: db.prepare("select c.date,c.note,-c.coins price,s.first,s.last from coin_log c join students s on s.id=c.student_id where kind='shop' order by c.id desc limit 30").all(),
}));
app.post('/api/admin/groups', A, (req, res) => { const g = req.body; res.json({ id: db.prepare('insert into groups(name,subject,days,time) values(?,?,?,?)').run(g.name, g.subject, g.days, g.time).lastInsertRowid }); });
app.put('/api/admin/groups/:id', A, (req, res) => { const g = req.body; db.prepare('update groups set name=?,subject=?,days=?,time=? where id=?').run(g.name, g.subject, g.days, g.time, req.params.id); res.json({ ok: true }); });
app.post('/api/admin/applications/:id/accept', A, (req, res) => {
  const a = db.prepare('select * from applications where id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Topilmadi' });
  const r = makeStudent(a, req.body.group_id);
  const ref = a.ref_code && db.prepare('select id from students where ref_code=?').get(a.ref_code);
  if (ref) { addCoin(ref.id, 'referral', 100, `${a.first} ${a.last} taklifi`); db.prepare('update students set ref_code=? where id=?').run(newCode(), ref.id); db.prepare('update students set referred_by=? where id=?').run(ref.id, r.id); }
  db.prepare("update applications set status='qabul' where id=?").run(a.id); res.json(r);
});
app.post('/api/admin/applications/:id/reject', A, (req, res) => { db.prepare("update applications set status='rad' where id=?").run(req.params.id); res.json({ ok: true }); });
app.post('/api/admin/students/:id/reset', A, (req, res) => { const p = rnd(6); db.prepare('update students set pass=? where id=?').run(hash(p), req.params.id); res.json({ password: p }); });
app.post('/api/admin/students/:id/group', A, (req, res) => { db.prepare('update students set group_id=? where id=?').run(req.body.group_id, req.params.id); res.json({ ok: true }); });
app.get('/api/admin/payments', A, (req, res) => res.json(db.prepare(`select s.id,s.first,s.last,g.name gname,
  (select sum(amount) from payments where student_id=s.id and month=?) paid from students s left join groups g on g.id=s.group_id order by g.name,s.first`).all(req.query.month)));
app.post('/api/admin/payments', A, (req, res) => { const p = req.body; db.prepare('insert into payments(student_id,month,amount,created) values(?,?,?,?)').run(p.student_id, p.month, p.amount, today()); res.json({ ok: true }); });
app.get('/api/admin/attendance', A, (req, res) => res.json(db.prepare(`select s.id,s.first,s.last,a.status,a.reason,
  exists(select 1 from coin_log where student_id=s.id and kind='active' and date=?) active from students s left join attendance a on a.student_id=s.id and a.date=? where s.group_id=?`).all(req.query.date, req.query.date, req.query.group_id)));
app.post('/api/admin/attendance', A, (req, res) => {
  const { date, records } = req.body;
  for (const r of records) {
    db.prepare('insert or replace into attendance values(?,?,?,?)').run(r.student_id, date, r.status, r.reason || '');
    if (r.status === 'keldi' && once(r.student_id, 'attendance', date)) addCoin(r.student_id, 'attendance', 1, 'Darsga keldi', date);
    if (r.active && once(r.student_id, 'active', date)) addCoin(r.student_id, 'active', 1, 'Darsda faol', date);
  }
  res.json({ ok: true });
});
app.post('/api/admin/homework', A, (req, res) => {
  const { student_id, score, date = today() } = req.body;
  db.prepare('insert into grades(student_id,date,score) values(?,?,?)').run(student_id, date, score);
  if (score >= 85) addCoin(student_id, 'homework', 1, `Uy ishi: ${score} ball`, date);
  res.json({ ok: true });
});
app.post('/api/admin/shop', A, (req, res) => { db.prepare('insert into shop(name,price) values(?,?)').run(req.body.name, req.body.price); res.json({ ok: true }); });
app.delete('/api/admin/shop/:id', A, (req, res) => { db.prepare('delete from shop where id=?').run(req.params.id); res.json({ ok: true }); });

// ---- O'QUVCHI ----
const S = auth('student');
app.get('/api/me', S, (req, res) => res.json(stats(req.s.sid)));
app.post('/api/me/password', S, (req, res) => {
  const { login, password } = req.body;
  if (password && password.length < 4) return res.status(400).json({ error: "Parol kamida 4 belgi" });
  try {
    if (login) db.prepare('update students set username=? where id=?').run(login.toLowerCase().trim(), req.s.sid);
    if (password) db.prepare('update students set pass=? where id=?').run(hash(password), req.s.sid);
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Bu login band' }); }
});
app.post('/api/me/referral-new', S, (req, res) => { const c = newCode(); db.prepare('update students set ref_code=? where id=?').run(c, req.s.sid); res.json({ code: c }); });
app.get('/api/shop', S, (q, res) => res.json(db.prepare('select * from shop').all()));
app.post('/api/shop/:id/buy', S, (req, res) => {
  const it = db.prepare('select * from shop where id=?').get(req.params.id), bal = stats(req.s.sid).balance;
  if (!it) return res.status(404).json({ error: 'Topilmadi' });
  if (bal < it.price) return res.status(400).json({ error: "Tangalar yetarli emas" });
  addCoin(req.s.sid, 'shop', -it.price, it.name); res.json({ ok: true });
});

// ---- TELEGRAM BOT ----
if (process.env.BOT_TOKEN) {
  const TB = require('node-telegram-bot-api'), bot = new TB(process.env.BOT_TOKEN, { polling: true });
  const kb = { reply_markup: { keyboard: [['📊 Natijalarim', '🏆 Reyting'], ['📅 Dars vaqti', '🎁 Taklif kodi'], ['🚪 Chiqish']], resize_keyboard: true } };
  bot.on('message', m => {
    const id = String(m.chat.id), t = (m.text || '').trim(), row = db.prepare('select student_id from tg where chat_id=?').get(id);
    if (!row) {
      const [u, p] = t.split(/\s+/), s = u && db.prepare('select id,first,pass from students where username=?').get(u.toLowerCase());
      if (s && p && check(p, s.pass)) { db.prepare('insert or replace into tg values(?,?)').run(id, s.id); return bot.sendMessage(id, `Salom, ${s.first}! Kirdingiz ✅`, kb); }
      return bot.sendMessage(id, "Kirish uchun login va parolni bitta xabarda yuboring.\nMasalan: ali.valiyev abc123");
    }
    const st = stats(row.student_id);
    if (t.includes('Natijalarim')) return bot.sendMessage(id, `📊 ${st.first} ${st.last}\nGuruh: ${st.gname}\nO'rtacha baho: ${st.avg}\n🪙 Tangalar: ${st.balance} (jami topgan: ${st.earned})\n📝 Uy vazifa: ${st.homework} ta\n✅ Qatnashgan: ${st.attend} marta\n⚡ Faollik: ${st.active} marta`);
    if (t.includes('Reyting')) { const r = ranking(st.subject).slice(0, 10).map((x, i) => `${i + 1}. ${x.first} ${x.last} — ${x.e}`).join('\n'); return bot.sendMessage(id, `🏆 ${st.subject}: siz ${st.rank.place}-o'rindasiz (${st.rank.total} ta o'quvchi)\n\n${r}`); }
    if (t.includes('Dars vaqti')) return bot.sendMessage(id, `📅 ${st.gname}\nKunlar: ${st.days}\nVaqt: ${st.time}`);
    if (t.includes('Taklif')) return bot.sendMessage(id, `🎁 Taklif kodingiz: ${st.ref_code}\nDo'stingiz ro'yxatdan o'tishda shu kodni kiritsa, sizga 100 🪙 beriladi.`);
    if (t.includes('Chiqish')) { db.prepare('delete from tg where chat_id=?').run(id); return bot.sendMessage(id, 'Chiqdingiz.', { reply_markup: { remove_keyboard: true } }); }
    bot.sendMessage(id, 'Tugmalardan foydalaning 👇', kb);
  });
}
app.listen(process.env.PORT || 3000, () => console.log('Ishga tushdi'));
