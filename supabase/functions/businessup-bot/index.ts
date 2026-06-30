// Business UP - Bot conversazionale Telegram (menu, sondaggio in chat, tutorial step-by-step,
// dashboard utente) + tracking funnel + follow-up + CRM API (admin web).
// Supabase Edge Function (Deno, webhook mode), schema "businessup".

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

// ---------- CONFIG ----------
// I segreti arrivano dalle variabili d'ambiente della Edge Function
// (Supabase Dashboard → Edge Functions → Secrets, oppure `supabase secrets set`).
// Vedi .env.example per l'elenco delle chiavi richieste.
const env = (k: string): string => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Variabile d'ambiente mancante: ${k}`);
  return v;
};

const BOT_TOKEN = env("BOT_TOKEN");
const ADMIN_ID = parseInt(env("ADMIN_ID"), 10);
const BOT_USERNAME = Deno.env.get("BOT_USERNAME") || "BotBusinessUP_bot";
const WEBHOOK_SECRET = env("WEBHOOK_SECRET");
const ADMIN_API_KEY = env("ADMIN_API_KEY");
const CRON_SECRET = env("CRON_SECRET");
const FOLLOWUP_HOURS = [24, 72, 168];

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { db: { schema: "businessup" }, auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key, x-telegram-init-data",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
async function tg(method: string, payload: unknown): Promise<any> {
  const r = await fetch(`${TG}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return r.json();
}
function send(chatId: number, text: string, markup?: unknown) {
  const p: any = { chat_id: chatId, text };
  if (markup) p.reply_markup = markup;
  return tg("sendMessage", p);
}
function edit(chatId: number, msgId: number, text: string, markup?: unknown) {
  const p: any = { chat_id: chatId, message_id: msgId, text };
  if (markup) p.reply_markup = markup;
  return tg("editMessageText", p);
}
function logEvent(telegram_id: number, tipo: string, dettaglio: string | null = null) {
  return supabase.from("eventi").insert({ telegram_id, tipo, dettaglio });
}

// Verifica la firma initData di una Mini App Telegram; ritorna telegram_id se valido.
async function validateInitData(initData: string): Promise<number | null> {
  try {
    if (!initData) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
    const enc = new TextEncoder();
    const kSecret = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const secret = await crypto.subtle.sign("HMAC", kSecret, enc.encode(BOT_TOKEN));
    const kFinal = await crypto.subtle.importKey("raw", new Uint8Array(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", kFinal, enc.encode(dcs));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== hash) return null;
    const user = JSON.parse(params.get("user") || "{}");
    return user.id ?? null;
  } catch {
    return null;
  }
}

async function getGruppoConfig() {
  const { data } = await supabase.from("tenants").select("gruppo_chat_id, topic_risultati").eq("id", 1).maybeSingle();
  return { chat_id: data?.gruppo_chat_id || null, topic: data?.topic_risultati ?? null };
}

// Quale ref link mostrare per (utente, servizio): quello del referrer se affiliato approvato, altrimenti il principale.
async function resolveRefLink(tid: number, servizioId: number): Promise<string | null> {
  const { data: lead } = await supabase.from("leads").select("referred_by").eq("telegram_id", tid).maybeSingle();
  if (lead?.referred_by) {
    const { data: al } = await supabase.from("affiliate_link").select("ref_link").eq("telegram_id", lead.referred_by).eq("servizio_id", servizioId).eq("approvato", true).maybeSingle();
    if (al?.ref_link) return al.ref_link;
  }
  const { data: sv } = await supabase.from("servizi").select("link_principale").eq("id", servizioId).maybeSingle();
  return sv?.link_principale || null;
}

// ---------- SURVEY DEFINITION ----------
const SURVEY = [
  { key: "nome", type: "text", q: "Come ti chiami?" },
  { key: "livello_trading", type: "choice", q: "Il tuo livello di trading?", opts: ["Principiante", "Intermedio", "Avanzato"] },
  { key: "esperienza_broker", type: "choice", q: "Hai gia operato con broker reali?", opts: ["No mai", "Si da meno di 6 mesi", "Si da piu di 6 mesi"] },
  { key: "capitale", type: "choice", q: "Quanto capitale dedicheresti?", opts: ["Meno di 500 euro", "500-2.000 euro", "2.000-10.000 euro", "10.000+ euro"] },
  { key: "prodotto_preferito", type: "choice", q: "Quale metodo ti interessa?", opts: ["Broker vs Broker", "Prop vs Broker", "Bonus ADM", "Voglio capire prima"] },
  { key: "willingness_to_pay", type: "choice", q: "Disposto a pagare per un metodo testato?", opts: ["Solo se gratis", "Una tantum 50-200", "Una tantum 200-500", "Abbonamento", "Profit share"] },
  { key: "note_libere", type: "text", optional: true, q: "Domande, dubbi o aspettative? (scrivi, oppure premi Salta)" },
];
const CAP = SURVEY[3].opts!;
const WTP = SURVEY[5].opts!;
const BRK = SURVEY[2].opts!;

function qualifica(r: Record<string, string>): { stage: string; motivo: string | null } {
  const capOk = r.capitale === CAP[2] || r.capitale === CAP[3];
  const brokerOk = !!r.broker_usati && r.broker_usati !== BRK[0];
  const payOk = !!r.willingness_to_pay && r.willingness_to_pay !== WTP[0];
  if (!capOk) return { stage: "squalificato", motivo: "capitale_insufficiente" };
  if (!brokerOk) return { stage: "squalificato", motivo: "no_esperienza_broker" };
  if (!payOk) return { stage: "squalificato", motivo: "no_budget_mentale" };
  return { stage: "qualificato", motivo: null };
}
const MOTIVI: Record<string, string> = {
  capitale_insufficiente: "Grazie per aver risposto.\nCon meno di 2.000 euro questi metodi non girano in positivo - te lo dico prima, non dopo.\nQuando sei pronto, sono qui. Intanto puoi guardare i Tutorial dal menu.",
  no_esperienza_broker: "Grazie per aver risposto.\nSenza esperienza broker reale non puoi saltare i passi.\nTorna quando hai operato almeno una volta con soldi veri.",
  no_budget_mentale: "Grazie per aver risposto.\nQuesti metodi funzionano solo se sei disposto a investire su te stesso.\nQuando cambi idea, sono qui.",
};

// ---------- TUTORIALS (step by step) ----------
const TUT: Record<string, { titolo: string; steps: { t: string; b: string }[] }> = {
  bvb: {
    titolo: "Broker vs Broker",
    steps: [
      { t: "Cos'e", b: "Sfrutti le differenze di quotazione dello stesso strumento tra due broker diversi. Piccole discrepanze = opportunita." },
      { t: "Come funziona", b: "Compri su un broker e vendi sull'altro nello stesso momento, sullo stesso strumento. Lo spread differenziale e il tuo guadagno." },
      { t: "Requisiti", b: "Almeno 2.000 euro, due conti broker, connessione stabile, 1-2 ore al giorno per monitorare." },
      { t: "Broker giusti", b: "ECN/STP con spread bassi, che permettono EA e non vietano l'arbitraggio. Non tutti vanno bene." },
      { t: "Reality check", b: "Non e passivo. Serve gestione attiva e disciplina sul rischio. Se cerchi soldi facili, non e questo." },
    ],
  },
  prop: {
    titolo: "Prop vs Broker",
    steps: [
      { t: "La scelta", b: "Fare trading come cliente di un broker, oppure diventare prop trader con capitale finanziato. Vediamo i due lati." },
      { t: "Broker tradizionale", b: "Liberta totale e profitti tutti tuoi, ma servono capitale tuo e tutto il rischio e su di te." },
      { t: "Prop trader", b: "Non rischi capitale tuo per accedere: superi una challenge e ricevi un conto finanziato. Split 70-80%, ma regole e drawdown." },
      { t: "Quando prop / quando broker", b: "Prop se hai poco capitale e vuoi struttura. Broker se hai capitale e vuoi liberta." },
      { t: "Reality check", b: "Molti li combinano: prop per imparare sotto pressione, broker per scalare. Nessuna scorciatoia." },
    ],
  },
  bonus: {
    titolo: "Bonus ADM",
    steps: [
      { t: "Cosa sono", b: "Capitale extra offerto da broker regolati ADM. Non e denaro libero: e condizionato da un rollover." },
      { t: "Meccanismo", b: "Depositi, ricevi il bonus, 'giri' un volume stabilito (rollover), poi puoi prelevare." },
      { t: "Esempio", b: "Bonus 500 con rollover 30x = 15.000 euro di volume da muovere prima di sbloccarlo." },
      { t: "Strategia Business UP", b: "Broker affidabili, strategia a basso rischio per muovere il volume, calcolo preciso dei costi." },
      { t: "Reality check", b: "Non sono soldi facili. Se non sai tradare, il bonus non cambia nulla. Leggi sempre i termini." },
    ],
  },
  swap: {
    titolo: "BvB Swap",
    steps: [
      { t: "Cos'e", b: "Variante del Broker vs Broker che sfrutta le differenze di swap (interessi overnight) tra broker." },
      { t: "Meccanismo", b: "Long su un broker con swap positivo + short sull'altro: incassi il differenziale di swap mentre dormi." },
      { t: "Perche funziona", b: "Broker diversi applicano swap diversi: accordi di liquidita e markup creano inefficienze reali." },
      { t: "Vantaggi e limiti", b: "Poco attivo e rischio direzionale zero, ma immobilizza capitale: ROI realistico ~12% annuo." },
      { t: "Reality check", b: "Strategia per chi ha 5.000+ euro e sa muoversi tra broker. Non per principianti." },
    ],
  },
};
const TUT_ORDER = ["bvb", "prop", "bonus", "swap"];

// ---------- MENUS ----------
function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "Fai il sondaggio", callback_data: "m_survey" }],
      [{ text: "I miei dati", callback_data: "m_dash" }],
      [{ text: "Tutorial", callback_data: "m_tut" }],
    ],
  };
}
const PAGES = "https://hubbusinessup.github.io/businessup-funnel";
function replyMenu() {
  return {
    keyboard: [
      [
        { text: "👤 Dashboard", web_app: { url: `${PAGES}/dashboard.html` } },
        { text: "💼 Business List", web_app: { url: `${PAGES}/business-list.html` } },
        { text: "🏠 Home", web_app: { url: `${PAGES}/home.html` } },
      ],
      [
        { text: "📤 Condividi" },
        { text: "📰 News", web_app: { url: `${PAGES}/news.html` } },
        { text: "🆘 Supporto" },
      ],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}
function kbSurvey(i: number) {
  const q = SURVEY[i];
  const rows: any[] = [];
  if (q.type === "choice") { for (const o of q.opts!) rows.push([{ text: o }]); }
  else if (q.optional) rows.push([{ text: "Salta" }]);
  rows.push([{ text: "<< Menu" }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}
function kbTutMenu() {
  const rows: any[] = [];
  for (let i = 0; i < TUT_ORDER.length; i += 2) {
    const r: any[] = [{ text: TUT[TUT_ORDER[i]].titolo }];
    if (TUT_ORDER[i + 1]) r.push({ text: TUT[TUT_ORDER[i + 1]].titolo });
    rows.push(r);
  }
  rows.push([{ text: "<< Menu" }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}
function kbTutStep(i: number, last: number) {
  const nav: any[] = [];
  if (i > 0) nav.push({ text: "<< Indietro" });
  if (i < last) nav.push({ text: "Avanti >>" });
  const rows: any[] = [];
  if (nav.length) rows.push(nav);
  if (i === last) rows.push([{ text: "Fatto, ho capito" }]);
  rows.push([{ text: "<< Tutorial" }, { text: "<< Menu" }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}
function kbPrivacy() {
  return { keyboard: [[{ text: "Cancella i miei dati" }], [{ text: "<< Menu" }]], resize_keyboard: true, is_persistent: true };
}
function kbConsent() {
  return { keyboard: [[{ text: "Accetto e inizio" }], [{ text: "Leggi informativa" }], [{ text: "<< Menu" }]], resize_keyboard: true, is_persistent: true };
}
function kbDelConfirm() {
  return { keyboard: [[{ text: "SI cancella tutto" }], [{ text: "<< Menu" }]], resize_keyboard: true, is_persistent: true };
}
const INFO_TEXT = `ℹ️ Business UP\n\nNessun guru, nessun filtro. Solo metodi testati, numeri alla mano.\n\nCosa trovi qui:\n📋 Sondaggio — in 2 minuti capisco il tuo profilo\n📚 Tutorial — i metodi spiegati passo-passo (Broker vs Broker, Prop vs Broker, Bonus ADM, BvB Swap)\n👤 I miei dati — il tuo stato e i tuoi progressi\n\nUsa i bottoni qui sotto. 👇`;

function welcomeText(nome?: string): string {
  return `Ciao ${nome || ""}. Sono il bot di Business UP.\nNessun guru, nessun filtro. Solo dati e logica.\n\nDa qui fai tutto: sondaggio, i tuoi dati e i tutorial. Scegli dal menu.\n\nPrivacy e cancellazione dati: /privacy`;
}

// ---------- STATE ----------
async function getState(tid: number): Promise<any> {
  const { data } = await supabase.from("bot_state").select("*").eq("telegram_id", tid).maybeSingle();
  return data || { telegram_id: tid, flow: "none", step: 0, tutorial_key: null, data: {} };
}
function setState(tid: number, patch: Record<string, unknown>) {
  return supabase.from("bot_state").upsert({ telegram_id: tid, updated_at: new Date().toISOString(), ...patch }, { onConflict: "telegram_id" });
}
function clearState(tid: number) {
  return setState(tid, { flow: "none", step: 0, tutorial_key: null, data: {} });
}

// ---------- LEAD ----------
async function upsertLeadStart(from: any) {
  const { data: lead } = await supabase.from("leads").select("start_count, primo_start_at").eq("telegram_id", from.id).maybeSingle();
  const now = new Date().toISOString();
  await supabase.from("leads").upsert({
    telegram_id: from.id, username: from.username ?? null, nome: from.first_name ?? null, bot_started: true,
    start_count: (lead?.start_count ?? 0) + 1, primo_start_at: lead?.primo_start_at ?? now, ultimo_messaggio: now,
  }, { onConflict: "telegram_id" });
  await logEvent(from.id, "start");
}

// ---------- SURVEY FLOW (tastiera in basso) ----------
async function startSurvey(tid: number, chatId: number) {
  await setState(tid, { flow: "sondaggio", step: 0, data: {} });
  const q = SURVEY[0];
  await send(chatId, `Sondaggio (1/${SURVEY.length})\n\n${q.q}`, kbSurvey(0));
}
async function advanceSurvey(tid: number, chatId: number, value: string) {
  const st = await getState(tid);
  if (st.flow !== "sondaggio") return;
  const q = SURVEY[st.step];
  const data = st.data || {};
  data[q.key] = value;
  if (st.step >= SURVEY.length - 1) { await finishSurvey(tid, chatId, data); return; }
  await setState(tid, { step: st.step + 1, data });
  const nq = SURVEY[st.step + 1];
  await send(chatId, `Sondaggio (${st.step + 2}/${SURVEY.length})\n\n${nq.q}`, kbSurvey(st.step + 1));
}
async function finishSurvey(tid: number, chatId: number, data: Record<string, any>) {
  const row = {
    telegram_id: tid, nome: data.nome ?? null, livello_trading: data.livello_trading ?? null,
    broker_usati: data.esperienza_broker ?? null, capitale: data.capitale ?? null,
    prodotto_preferito: data.prodotto_preferito ?? null, willingness_to_pay: data.willingness_to_pay ?? null,
    note_libere: data.note_libere ?? null,
  };
  const { data: ex } = await supabase.from("sondaggio_risposte").select("id").eq("telegram_id", tid).maybeSingle();
  if (ex) await supabase.from("sondaggio_risposte").update(row).eq("id", ex.id);
  else await supabase.from("sondaggio_risposte").insert(row);

  const ql = qualifica(row as Record<string, string>);
  const now = new Date().toISOString();
  await supabase.from("leads").update({
    sondaggio_completato: true, sondaggio_completato_at: now, sondaggio_aperto_at: now,
    pipeline_stage: ql.stage, motivo_squalifica: ql.motivo, followup_livello: 0, ultimo_followup_at: null, ultimo_messaggio: now,
  }).eq("telegram_id", tid);
  await logEvent(tid, "sondaggio_completato");
  await logEvent(tid, ql.stage);

  await clearState(tid);
  if (ql.stage === "qualificato") {
    await send(chatId, "Profilo confermato.\nHai il capitale, l'esperienza e la testa giusta.\n\nApri 📚 Tutorial qui sotto: trovi i metodi spiegati passo-passo.", replyMenu());
  } else {
    await send(chatId, MOTIVI[ql.motivo!], replyMenu());
  }
}

// ---------- TUTORIAL FLOW (tastiera in basso) ----------
function tutStepText(key: string, i: number) {
  const tot = TUT[key].steps.length;
  const s = TUT[key].steps[i];
  return `${TUT[key].titolo}  (${i + 1}/${tot})\n\n${s.t}\n${s.b}`;
}
async function showTutMenu(tid: number, chatId: number) {
  await setState(tid, { flow: "tutmenu", step: 0, tutorial_key: null, data: {} });
  await send(chatId, "Tutorial - scegli un metodo (poi naviga coi bottoni in basso):", kbTutMenu());
}
async function startTutorial(tid: number, chatId: number, key: string) {
  await setState(tid, { flow: "tutorial", tutorial_key: key, step: 0 });
  await supabase.from("tutorial_progress").upsert({ telegram_id: tid, tutorial_key: key, ultimo_step: 0, updated_at: new Date().toISOString() }, { onConflict: "telegram_id,tutorial_key" });
  await supabase.from("leads").update({ ultimo_tutorial_at: new Date().toISOString(), followup_livello: 0, ultimo_followup_at: null }).eq("telegram_id", tid);
  await logEvent(tid, "tutorial_click", key);
  await send(chatId, tutStepText(key, 0), kbTutStep(0, TUT[key].steps.length - 1));
}
async function tutNav(tid: number, chatId: number, dir: number) {
  const st = await getState(tid);
  if (st.flow !== "tutorial" || !st.tutorial_key) return;
  const key = st.tutorial_key;
  const last = TUT[key].steps.length - 1;
  let i = (st.step ?? 0) + dir;
  if (i < 0) i = 0;
  if (i > last) i = last;
  await setState(tid, { step: i });
  await supabase.from("tutorial_progress").upsert({ telegram_id: tid, tutorial_key: key, ultimo_step: i, updated_at: new Date().toISOString() }, { onConflict: "telegram_id,tutorial_key" });
  await send(chatId, tutStepText(key, i), kbTutStep(i, last));
}
async function tutDone(tid: number, chatId: number) {
  const st = await getState(tid);
  const key = st.tutorial_key;
  if (key) {
    await supabase.from("tutorial_progress").upsert({ telegram_id: tid, tutorial_key: key, completato: true, updated_at: new Date().toISOString() }, { onConflict: "telegram_id,tutorial_key" });
    await logEvent(tid, "tutorial_completato", key);
  }
  await setState(tid, { flow: "tutmenu", step: 0, tutorial_key: null, data: {} });
  await send(chatId, "Completato. Se vuoi iniziare con questo metodo premi 'Voglio iniziare', oppure scegli un altro tutorial.", { keyboard: [[{ text: "Voglio iniziare" }], [{ text: "<< Tutorial" }, { text: "<< Menu" }]], resize_keyboard: true, is_persistent: true });
}
async function doInteresse(tid: number, chatId: number, from: any) {
  const now = new Date().toISOString();
  await supabase.from("leads").update({ interesse_at: now, pipeline_stage: "contattato", followup_livello: 0, ultimo_followup_at: null, ultimo_messaggio: now }).eq("telegram_id", tid);
  await logEvent(tid, "interesse");
  await clearState(tid);
  const uname = from?.username ? "@" + from.username : tid;
  try { await send(ADMIN_ID, `${uname} ha premuto "Voglio iniziare".`); } catch { /* */ }
  await send(chatId, "Perfetto. Ti ricontatto a breve di persona.", replyMenu());
}

// ---------- DASHBOARD ----------
function stageLabel(s: string) {
  return ({ nuovo: "Nuovo", qualificato: "Qualificato", squalificato: "Non idoneo ora", contattato: "In contatto", cliente: "Cliente" } as Record<string, string>)[s] || s;
}
async function homeView(tid: number) {
  const { data: lead } = await supabase.from("leads").select("*").eq("telegram_id", tid).maybeSingle();
  const { data: sond } = await supabase.from("sondaggio_risposte").select("*").eq("telegram_id", tid).maybeSingle();
  const { data: prog } = await supabase.from("tutorial_progress").select("completato").eq("telegram_id", tid);
  const { data: ls } = await supabase.from("lead_servizi").select("servizio_id, stato").eq("telegram_id", tid);
  let serviziTxt = "nessuno";
  if (ls && ls.length) {
    const { data: serv } = await supabase.from("servizi").select("id, nome");
    const map: Record<number, string> = {};
    for (const s of serv ?? []) map[(s as any).id] = (s as any).nome;
    serviziTxt = ls.map((x: any) => `${map[x.servizio_id] || "?"} (${x.stato})`).join(", ");
  }
  const done = (prog ?? []).filter((p: any) => p.completato).length;
  let t = `Business UP - la tua dashboard\n\n`;
  t += `Nome: ${lead?.nome || "-"}\n`;
  t += `Stato: ${stageLabel(lead?.pipeline_stage || "nuovo")}\n`;
  if (sond) {
    t += `Capitale: ${sond.capitale || "-"}\n`;
    t += `Esperienza: ${sond.broker_usati || "-"}\n`;
  } else {
    t += `Sondaggio: ancora da fare\n`;
  }
  t += `Tutorial completati: ${done}/${TUT_ORDER.length}\n`;
  t += `Servizi: ${serviziTxt}\n\nScegli:`;
  const markup = {
    inline_keyboard: [
      [{ text: sond ? "Rifai il sondaggio" : "Fai il sondaggio", callback_data: "m_survey" }],
      [{ text: "Servizi e Tutorial", callback_data: "m_tut" }],
      [{ text: "Info", callback_data: "m_info" }, { text: "Privacy", callback_data: "privacy_show" }],
    ],
  };
  return { text: t, markup };
}
async function sendHome(tid: number, chatId: number) {
  const v = await homeView(tid);
  await send(chatId, v.text, v.markup);
}
async function sendCard(tid: number, chatId: number) {
  const v = await homeView(tid);
  await send(chatId, v.text, replyMenu());
}
async function editHome(tid: number, chatId: number, msgId: number) {
  const v = await homeView(tid);
  await edit(chatId, msgId, v.text, v.markup);
}

// ---------- PRIVACY / GDPR ----------
const PRIVACY_TEXT = `Informativa privacy - Business UP

Titolare del trattamento: Business UP. Contatto: antonybusinesshub@gmail.com

Dati trattati:
- ID e username Telegram, nome.
- Risposte al sondaggio (capitale, esperienza, preferenze) e uso del bot (tutorial visti, ecc.).

Finalita: capire il tuo profilo e indirizzarti ai metodi/servizi adatti, e contattarti in merito.
Base giuridica: il tuo consenso.
Conservazione: finche usi il servizio o finche non chiedi la cancellazione.
Non vendiamo i tuoi dati a terzi.

I tuoi diritti: accedere ai tuoi dati (menu "I miei dati"), correggerli (rifacendo il sondaggio), cancellarli quando vuoi. Per altre richieste scrivi a antonybusinesshub@gmail.com`;

function privacyMarkup() {
  return { inline_keyboard: [[{ text: "Cancella i miei dati", callback_data: "del_me" }], [{ text: "<< Dashboard", callback_data: "m_home" }]] };
}

async function deleteUserData(tid: number) {
  await supabase.from("sondaggio_risposte").delete().eq("telegram_id", tid);
  await supabase.from("eventi").delete().eq("telegram_id", tid);
  await supabase.from("tutorial_progress").delete().eq("telegram_id", tid);
  await supabase.from("bot_state").delete().eq("telegram_id", tid);
  await supabase.from("lead_servizi").delete().eq("telegram_id", tid);
  await supabase.from("note").delete().eq("telegram_id", tid);
  await supabase.from("leads").delete().eq("telegram_id", tid);
}

async function surveyEntry(tid: number, chatId: number) {
  const { data: lead } = await supabase.from("leads").select("consenso_privacy").eq("telegram_id", tid).maybeSingle();
  if (lead?.consenso_privacy) return startSurvey(tid, chatId);
  await send(chatId, "Prima di iniziare: per il sondaggio raccolgo i tuoi dati. Premendo \"Accetto e inizio\" acconsenti al trattamento (vedi \"Leggi informativa\").", kbConsent());
}

// ---------- ADMIN (telegram commands) ----------
async function getStats() {
  const { data } = await supabase.from("leads").select("pipeline_stage");
  const rows = data ?? [];
  const c = (s: string) => rows.filter((l: any) => l.pipeline_stage === s).length;
  const tot = rows.length, q = c("qualificato");
  return { totale: tot, qualificati: q, squalificati: c("squalificato"), clienti: c("cliente"), contattati: c("contattato"), nuovi: c("nuovo"), tassoQualifica: tot ? ((q / tot) * 100).toFixed(1) + "%" : "0%" };
}
async function getMetrics() {
  const { data: leads } = await supabase.from("leads").select("start_count, sondaggio_aperto_at, sondaggio_completato, motivo_squalifica, ultimo_tutorial_at, interesse_at, convertito_at");
  const L = leads ?? [];
  const { data: eventi } = await supabase.from("eventi").select("tipo, dettaglio");
  const E = eventi ?? [];
  const f = (p: (l: any) => boolean) => L.filter(p).length;
  const entrati = f((l) => (l.start_count ?? 0) > 0);
  const sondaggio_aperto = f((l) => l.sondaggio_aperto_at);
  const sondaggio_completato = f((l) => l.sondaggio_completato);
  const qualificati = f((l) => l.sondaggio_completato && !l.motivo_squalifica);
  const squalificati = f((l) => l.sondaggio_completato && l.motivo_squalifica);
  const tutorial_utenti = f((l) => l.ultimo_tutorial_at);
  const interessati = f((l) => l.interesse_at);
  const clienti = f((l) => l.convertito_at);
  const tc = E.filter((e: any) => e.tipo === "tutorial_click");
  const tb: Record<string, number> = {};
  for (const e of tc) { const k = (e as any).dettaglio || "?"; tb[k] = (tb[k] ?? 0) + 1; }
  const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + "%" : "0%");
  return {
    entrati, start_click_totali: E.filter((e: any) => e.tipo === "start").length, sondaggio_aperto, sondaggio_completato,
    qualificati, squalificati, tutorial_utenti, tutorial_click_totali: tc.length, tutorial_breakdown: tb, interessati, clienti,
    conversioni: { start_to_aperto: pct(sondaggio_aperto, entrati), aperto_to_completato: pct(sondaggio_completato, sondaggio_aperto), qualificati_to_tutorial: pct(tutorial_utenti, qualificati), tutorial_to_interesse: pct(interessati, tutorial_utenti), interesse_to_cliente: pct(clienti, interessati), start_to_cliente: pct(clienti, entrati) },
  };
}
async function broadcast(stage: string, text: string) {
  let q = supabase.from("leads").select("telegram_id");
  if (stage !== "all") q = q.eq("pipeline_stage", stage);
  const { data: leads } = await q;
  const list = leads ?? [];
  let inviati = 0, falliti = 0;
  for (const l of list) { try { const r = await tg("sendMessage", { chat_id: l.telegram_id, text }); r.ok ? inviati++ : falliti++; } catch { falliti++; } }
  const tipo = stage === "all" ? "all" : stage === "qualificato" ? "qualificati" : stage === "squalificato" ? "squalificati" : "singolo";
  await supabase.from("broadcast_log").insert({ tipo, testo: text, destinatari_count: list.length, inviati, falliti });
  return { inviati, falliti, totale: list.length };
}
async function handleAdmin(text: string, chatId: number) {
  const parts = text.split(" ");
  const cmd = parts[0];
  const arg = parts.slice(1).join(" ");
  if (cmd === "/kpi") { const s = await getStats(); return send(chatId, `KPI\n\nTotale: ${s.totale}\nQualificati: ${s.qualificati}\nSqualificati: ${s.squalificati}\nContattati: ${s.contattati}\nClienti: ${s.clienti}\nNuovi: ${s.nuovi}\nTasso qualifica: ${s.tassoQualifica}`); }
  if (cmd === "/funnel") { const m = await getMetrics(); return send(chatId, `Funnel\n\nEntrati: ${m.entrati}\nSondaggio aperto: ${m.sondaggio_aperto} (${m.conversioni.start_to_aperto})\nCompletato: ${m.sondaggio_completato}\nQualificati: ${m.qualificati} / Squalificati: ${m.squalificati}\nTutorial visti: ${m.tutorial_utenti}\nInteressati: ${m.interessati}\nClienti: ${m.clienti}\nstart->cliente: ${m.conversioni.start_to_cliente}`); }
  if (cmd === "/lista") {
    const { data } = await supabase.from("leads").select("username, telegram_id, nome, pipeline_stage").order("created_at", { ascending: false }).limit(20);
    const rows = data ?? [];
    if (!rows.length) return send(chatId, "Nessun lead.");
    let t = "Ultimi 20 lead\n\n";
    for (const l of rows) t += `${l.pipeline_stage} - @${l.username || l.telegram_id} (${l.nome || "-"})\n`;
    return send(chatId, t);
  }
  if (cmd === "/send_q" || cmd === "/send_s" || cmd === "/send_all") {
    if (!arg) return send(chatId, `Uso: ${cmd} [testo]`);
    const stage = cmd === "/send_q" ? "qualificato" : cmd === "/send_s" ? "squalificato" : "all";
    const res = await broadcast(stage, arg);
    return send(chatId, `Broadcast: ${res.inviati} inviati, ${res.falliti} falliti (su ${res.totale}).`);
  }
  if (cmd === "/dm") {
    const uname = (parts[1] || "").replace(/^@/, ""); const msg = parts.slice(2).join(" ");
    if (!uname || !msg) return send(chatId, "Uso: /dm @username [testo]");
    const { data: lead } = await supabase.from("leads").select("telegram_id").ilike("username", uname).maybeSingle();
    if (!lead) return send(chatId, `Lead @${uname} non trovato.`);
    try { await tg("sendMessage", { chat_id: lead.telegram_id, text: msg }); return send(chatId, `Inviato a @${uname}.`); } catch { return send(chatId, `Errore invio a @${uname}.`); }
  }
  if (cmd === "/cliente" || cmd === "/set_stage") {
    const uname = (parts[1] || "").replace(/^@/, ""); const stage = cmd === "/cliente" ? "cliente" : parts[2];
    const valid = ["nuovo", "qualificato", "squalificato", "contattato", "cliente"];
    if (!uname || !valid.includes(stage)) return send(chatId, cmd === "/cliente" ? "Uso: /cliente @username" : `Uso: /set_stage @username [${valid.join("/")}]`);
    const { data: lead } = await supabase.from("leads").select("telegram_id, convertito_at").ilike("username", uname).maybeSingle();
    if (!lead) return send(chatId, `Lead @${uname} non trovato.`);
    const patch: Record<string, unknown> = { pipeline_stage: stage, followup_livello: 0, ultimo_followup_at: null };
    if (stage === "cliente" && !lead.convertito_at) { patch.convertito_at = new Date().toISOString(); await logEvent(lead.telegram_id, "convertito"); }
    await supabase.from("leads").update(patch).eq("telegram_id", lead.telegram_id);
    return send(chatId, `Stage di @${uname} -> ${stage}.`);
  }
  if (cmd === "/menu" || cmd === "/admin") {
    return send(chatId, "Comandi admin:\n/kpi /funnel /lista\n/send_q /send_s /send_all [testo]\n/dm @user [testo]\n/cliente @user\n/set_stage @user [stage]\n\nCRM completo: apri la dashboard web.");
  }
}

// ---------- UPDATE ROUTER ----------
async function handleUpdate(u: any) {
  if (u.message?.new_chat_members) {
    for (const mem of u.message.new_chat_members) {
      if (mem.is_bot) continue;
      await upsertLeadStart(mem);
      try {
        await send(mem.id, `Ciao ${mem.first_name || ""}. Benvenuto in Business UP.\nPrima cosa: 2 minuti di sondaggio.`);
        await surveyEntry(mem.id, mem.id);
      } catch { /* */ }
    }
    return;
  }

  if (u.message?.photo) {
    const from = u.message.from;
    const chatId = u.message.chat.id;
    const st = await getState(from.id);
    if (st.flow === "risultato") {
      const photos = u.message.photo;
      const fileId = photos[photos.length - 1].file_id;
      await setState(from.id, { flow: "risultato", data: { file_id: fileId } });
      await send(chatId, "Vuoi pubblicarlo col tuo nome o anonimo?", { keyboard: [[{ text: "Col mio nome" }], [{ text: "Anonimo" }], [{ text: "Annulla" }]], resize_keyboard: true, is_persistent: true });
    }
    return;
  }

  if (u.message?.text) {
    const from = u.message.from;
    const chatId = u.message.chat.id;
    const text = u.message.text.trim();

    if (text === "/start" || text.startsWith("/start ")) {
      await upsertLeadStart(from);
      const payload = text.startsWith("/start ") ? text.slice(7).trim() : "";
      if (payload.startsWith("ref_")) {
        const refId = parseInt(payload.slice(4));
        if (refId && refId !== from.id) {
          const { data: me } = await supabase.from("leads").select("referred_by").eq("telegram_id", from.id).maybeSingle();
          if (me && !me.referred_by) {
            await supabase.from("leads").update({ referred_by: refId }).eq("telegram_id", from.id);
            await logEvent(from.id, "referral", String(refId));
          }
        }
      }
      await clearState(from.id);
      const { data: lead } = await supabase.from("leads").select("sondaggio_completato").eq("telegram_id", from.id).maybeSingle();
      if (lead?.sondaggio_completato) {
        await send(chatId, welcomeText(from.first_name), replyMenu());
      } else {
        await send(chatId, `Ciao ${from.first_name || ""}. Benvenuto in Business UP.\nNessun guru, nessun filtro. Solo dati e logica.\n\nPrima cosa: 2 minuti di sondaggio per capire dove sei.`);
        await surveyEntry(from.id, chatId);
      }
      return;
    }
    if (text === "/privacy") { await send(chatId, PRIVACY_TEXT, kbPrivacy()); return; }
    if (text === "/sondaggio") { await surveyEntry(from.id, chatId); return; }
    if (text === "/id" || text.startsWith("/id@") || text.startsWith("/id ")) {
      if (from.id === ADMIN_ID) {
        const tt = u.message.message_thread_id;
        await tg("sendMessage", { chat_id: chatId, message_thread_id: tt, text: `chat_id: ${chatId}\ntopic (message_thread_id): ${tt ?? "nessuno"}` });
      }
      return;
    }
    if (text === "/setrisultati") {
      if (from.id === ADMIN_ID) {
        const tt = u.message.message_thread_id ?? null;
        await supabase.from("tenants").update({ gruppo_chat_id: chatId, topic_risultati: tt }).eq("id", 1);
        await tg("sendMessage", { chat_id: chatId, message_thread_id: tt, text: `Topic risultati impostato. chat:${chatId} topic:${tt ?? "nessuno"}` });
      }
      return;
    }
    if (text === "/risultato") {
      await setState(from.id, { flow: "risultato", data: {} });
      await send(chatId, "Mandami lo screenshot del tuo risultato (una foto).", { keyboard: [[{ text: "Annulla" }]], resize_keyboard: true });
      return;
    }
    if (text.startsWith("/setgruppolink")) {
      if (from.id === ADMIN_ID) {
        const link = text.split(" ").slice(1).join(" ").trim();
        if (link) { await supabase.from("tenants").update({ gruppo_link: link }).eq("id", 1); await send(chatId, "Link community impostato: " + link); }
        else await send(chatId, "Uso: /setgruppolink https://t.me/...");
      }
      return;
    }
    if (from.id === ADMIN_ID && text.startsWith("/")) { await handleAdmin(text, chatId); return; }
    if (text === "/menu") { await clearState(from.id); await send(chatId, "Menu:", replyMenu()); return; }

    const st = await getState(from.id);

    // --- flusso SONDAGGIO ---
    if (st.flow === "sondaggio") {
      if (text === "<< Menu") { await clearState(from.id); await send(chatId, "Menu:", replyMenu()); return; }
      const q = SURVEY[st.step];
      if (q.type === "choice") {
        if (q.opts!.includes(text)) { await advanceSurvey(from.id, chatId, text); return; }
        await send(chatId, `Scegli un'opzione:\n${q.q}`, kbSurvey(st.step)); return;
      } else {
        if (q.optional && text === "Salta") { await advanceSurvey(from.id, chatId, ""); return; }
        await advanceSurvey(from.id, chatId, text); return;
      }
    }

    // --- flusso MENU TUTORIAL ---
    if (st.flow === "tutmenu") {
      if (text === "<< Menu") { await clearState(from.id); await send(chatId, "Menu:", replyMenu()); return; }
      if (text === "Voglio iniziare") { await doInteresse(from.id, chatId, from); return; }
      const key = TUT_ORDER.find((k) => TUT[k].titolo === text);
      if (key) { await startTutorial(from.id, chatId, key); return; }
      await showTutMenu(from.id, chatId); return;
    }

    // --- flusso TUTORIAL (step) ---
    if (st.flow === "tutorial") {
      if (text === "Avanti >>") { await tutNav(from.id, chatId, 1); return; }
      if (text === "<< Indietro") { await tutNav(from.id, chatId, -1); return; }
      if (text === "Fatto, ho capito") { await tutDone(from.id, chatId); return; }
      if (text === "<< Tutorial") { await showTutMenu(from.id, chatId); return; }
      if (text === "<< Menu") { await clearState(from.id); await send(chatId, "Menu:", replyMenu()); return; }
      if (text === "Voglio iniziare") { await doInteresse(from.id, chatId, from); return; }
      const key = st.tutorial_key;
      if (key) await send(chatId, tutStepText(key, st.step), kbTutStep(st.step, TUT[key].steps.length - 1));
      return;
    }

    // --- flusso RISULTATO (pubblicazione nel gruppo) ---
    if (st.flow === "risultato") {
      if (text === "Annulla") { await clearState(from.id); await send(chatId, "Annullato.", replyMenu()); return; }
      if (text === "Col mio nome" || text === "Anonimo") {
        const fileId = st.data?.file_id;
        if (!fileId) { await clearState(from.id); await send(chatId, "Manca la foto. Riprova con /risultato.", replyMenu()); return; }
        const cfg = await getGruppoConfig();
        if (!cfg.chat_id) { await clearState(from.id); await send(chatId, "Pubblicazione non ancora configurata.", replyMenu()); return; }
        const autore = text === "Col mio nome" ? (from.username ? "@" + from.username : (from.first_name || "utente")) : "un utente Business UP";
        const payload: any = { chat_id: cfg.chat_id, photo: fileId, caption: `Risultato condiviso da ${autore}.` };
        if (cfg.topic) payload.message_thread_id = cfg.topic;
        const r = await tg("sendPhoto", payload);
        await clearState(from.id);
        if (r.ok) { await logEvent(from.id, "risultato_pubblicato"); await send(chatId, "Pubblicato nel gruppo. Grazie!", replyMenu()); }
        else await send(chatId, "Non sono riuscito a pubblicare (il bot deve essere admin del gruppo).", replyMenu());
        return;
      }
      await send(chatId, "Mandami lo screenshot (foto) oppure premi Annulla.", { keyboard: [[{ text: "Annulla" }]], resize_keyboard: true });
      return;
    }

    // --- flusso SUPPORTO ---
    if (st.flow === "supporto") {
      if (text === "Annulla") { await clearState(from.id); await send(chatId, "Annullato.", replyMenu()); return; }
      const uname = from.username ? "@" + from.username : (from.first_name || from.id);
      try { await send(ADMIN_ID, `🆘 Supporto da ${uname} (${from.id}):\n${text}`); } catch { /* */ }
      await clearState(from.id);
      await send(chatId, "Messaggio inviato al team. Ti rispondiamo a breve.", replyMenu());
      return;
    }

    // --- MENU PRINCIPALE (flow none) ---
    if (text === "📋 Sondaggio") { await surveyEntry(from.id, chatId); return; }
    if (text === "📤 Condividi") {
      const refLink = `https://t.me/${BOT_USERNAME}?start=ref_${from.id}`;
      const shareText = "Entra in Business UP: metodi di trading testati, numeri alla mano. Niente guru, niente filtri.";
      const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent(shareText)}`;
      await send(chatId, `Condividi Business UP col TUO link. Chi entra da qui e attiva un servizio dove sei affiliato usa il tuo ref.\n\nIl tuo link (copialo per WhatsApp, Instagram, ovunque):\n${refLink}`, { inline_keyboard: [[{ text: "📤 Condividi su Telegram", url: shareUrl }]] });
      return;
    }
    if (text === "🆘 Supporto") { await setState(from.id, { flow: "supporto", data: {} }); await send(chatId, "Scrivi il tuo messaggio per il team Business UP: te lo giro e ti rispondo.", { keyboard: [[{ text: "Annulla" }]], resize_keyboard: true }); return; }
    if (text === "👤 I miei dati") { await sendCard(from.id, chatId); return; }
    if (text === "📚 Tutorial") { await showTutMenu(from.id, chatId); return; }
    if (text === "ℹ️ Info") { await send(chatId, INFO_TEXT, replyMenu()); return; }
    if (text === "🔒 Privacy") { await send(chatId, PRIVACY_TEXT, kbPrivacy()); return; }
    if (text === "Cancella i miei dati") { await send(chatId, "Cancellare TUTTI i tuoi dati? Azione definitiva.", kbDelConfirm()); return; }
    if (text === "SI cancella tutto") { await deleteUserData(from.id); await send(chatId, "Fatto. Dati cancellati. Scrivi /start per ricominciare.", { remove_keyboard: true }); return; }
    if (text === "Leggi informativa") { await send(chatId, PRIVACY_TEXT, kbPrivacy()); return; }
    if (text === "Accetto e inizio") {
      await supabase.from("leads").update({ consenso_privacy: true, consenso_at: new Date().toISOString() }).eq("telegram_id", from.id);
      await logEvent(from.id, "consenso_privacy");
      await startSurvey(from.id, chatId); return;
    }
    if (text === "Voglio iniziare") { await doInteresse(from.id, chatId, from); return; }
    if (text === "<< Menu" || text === "<< Tutorial") { await send(chatId, "Menu:", replyMenu()); return; }

    await send(chatId, "Usa i bottoni in basso.", replyMenu());
    return;
  }

  if (u.callback_query) {
    const cq = u.callback_query;
    await tg("answerCallbackQuery", { callback_query_id: cq.id });
    try { await send(cq.message.chat.id, "Usa i bottoni in basso 👇", replyMenu()); } catch { /* */ }
    return;
  }
}

// ---------- CRM card ----------
async function getLeadCard(tid: number) {
  const { data: lead } = await supabase.from("leads").select("*").eq("telegram_id", tid).maybeSingle();
  const { data: sondaggio } = await supabase.from("sondaggio_risposte").select("*").eq("telegram_id", tid).maybeSingle();
  const { data: eventi } = await supabase.from("eventi").select("tipo, dettaglio, created_at").eq("telegram_id", tid).order("created_at", { ascending: false }).limit(50);
  const { data: ls } = await supabase.from("lead_servizi").select("*").eq("telegram_id", tid).order("created_at", { ascending: false });
  const { data: servizi } = await supabase.from("servizi").select("id, nome");
  const sMap: Record<number, string> = {};
  for (const s of servizi ?? []) sMap[(s as any).id] = (s as any).nome;
  const servizi_lead = (ls ?? []).map((r: any) => ({ ...r, nome: sMap[r.servizio_id] || "?" }));
  const { data: note } = await supabase.from("note").select("*").eq("telegram_id", tid).order("created_at", { ascending: false });
  const { data: tut } = await supabase.from("tutorial_progress").select("tutorial_key, ultimo_step, completato, updated_at").eq("telegram_id", tid);
  const tutMap: Record<string, string> = { bvb: "Broker vs Broker", prop: "Prop vs Broker", bonus: "Bonus ADM", swap: "BvB Swap" };
  const tutorial = (tut ?? []).map((t: any) => ({ ...t, nome: tutMap[t.tutorial_key] || t.tutorial_key }));
  const { data: pagamenti } = await supabase.from("pagamenti").select("id, servizio_id, importo, nota, data").eq("telegram_id", tid).order("data", { ascending: false });
  const pag = (pagamenti ?? []).map((p: any) => ({ ...p, nomeServ: sMap[p.servizio_id] || "" }));
  return { lead, sondaggio, eventi: eventi ?? [], servizi: servizi_lead, note: note ?? [], tutorial, pagamenti: pag };
}

// ---------- FOLLOW-UP ----------
function followupMessage(segment: string, level: number) {
  const SU = "Apri il bot e completa il sondaggio dal menu.";
  const M: Record<string, string[]> = {
    no_survey: ["Hai avviato il bot ma non hai fatto il sondaggio. " + SU, "Ti ricordo il sondaggio: senza non posso indirizzarti. " + SU, "Ultimo promemoria sul sondaggio. " + SU],
    survey_incompleto: ["Hai iniziato il sondaggio ma non l'hai finito. Riprendi dal menu.", "Mancano poche risposte per il tuo profilo. Riprendi dal menu.", "Ultimo richiamo: finisci il sondaggio dal menu."],
    no_tutorial: ["Sei qualificato ma non hai aperto i tutorial. Premi Tutorial nel menu.", "I materiali sono pronti. Aprili dal menu, sezione Tutorial.", "Ultimo richiamo sui tutorial."],
    tutorial_no_interesse: ["Hai guardato i materiali. Se vuoi partire, premi 'Voglio iniziare'.", "Pronto a fare sul serio? Premi 'Voglio iniziare'.", "Ultimo messaggio: se vuoi iniziare sono qui."],
  };
  return (M[segment] || ["Ciao."])[Math.min(level - 1, 2)];
}
async function runFollowup() {
  const { data: leads } = await supabase.from("leads").select("telegram_id, sondaggio_completato, sondaggio_aperto_at, motivo_squalifica, ultimo_tutorial_at, interesse_at, convertito_at, bot_started, primo_start_at, sondaggio_completato_at, followup_livello, ultimo_followup_at");
  const L = leads ?? [];
  const now = Date.now();
  let inviati = 0, valutati = 0;
  for (const l of L as any[]) {
    if (!l.bot_started || l.convertito_at || l.interesse_at) continue;
    let segment = "", base: string | null = null;
    if (!l.sondaggio_completato) {
      if (l.sondaggio_aperto_at) { segment = "survey_incompleto"; base = l.sondaggio_aperto_at; }
      else { segment = "no_survey"; base = l.primo_start_at; }
    } else {
      if (l.motivo_squalifica) continue;
      if (l.ultimo_tutorial_at) { segment = "tutorial_no_interesse"; base = l.ultimo_tutorial_at; }
      else { segment = "no_tutorial"; base = l.sondaggio_completato_at; }
    }
    if (!base) continue;
    const livello = l.followup_livello ?? 0;
    if (livello >= 3) continue;
    valutati++;
    const ref = l.ultimo_followup_at ? new Date(l.ultimo_followup_at).getTime() : new Date(base).getTime();
    if (now - ref < FOLLOWUP_HOURS[livello] * 3600 * 1000) continue;
    const nextLevel = livello + 1;
    const markup = replyMenu();
    try {
      const r = await tg("sendMessage", { chat_id: l.telegram_id, text: followupMessage(segment, nextLevel), reply_markup: markup });
      if (r.ok) { inviati++; await supabase.from("leads").update({ followup_livello: nextLevel, ultimo_followup_at: new Date(now).toISOString() }).eq("telegram_id", l.telegram_id); await logEvent(l.telegram_id, "followup", `${segment}_L${nextLevel}`); }
    } catch { /* */ }
  }
  return { valutati, inviati, totale: L.length };
}

// ---------- ROUTER ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const i = parts.indexOf("businessup-bot");
  const sub = i >= 0 ? parts.slice(i + 1).join("/") : "";
  try {
    if (sub === "telegram") {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) return json({ error: "unauthorized" }, 401);
      await handleUpdate(await req.json());
      return json({ ok: true });
    }
    if (sub === "cron-followup") {
      if (url.searchParams.get("key") !== CRON_SECRET) return json({ error: "unauthorized" }, 401);
      return json(await runFollowup());
    }
    // Tracking dalla Mini App tutorial (pubblico, solo analytics tutorial)
    if (sub === "track") {
      const b = await req.json();
      const tid = parseInt(b.telegram_id);
      const key = b.tutorial_key;
      if (!tid || !key) return json({ ok: false });
      if (b.event === "open") {
        await supabase.from("leads").update({ ultimo_tutorial_at: new Date().toISOString(), followup_livello: 0, ultimo_followup_at: null }).eq("telegram_id", tid);
        await supabase.from("tutorial_progress").upsert({ telegram_id: tid, tutorial_key: key, ultimo_step: 0, updated_at: new Date().toISOString() }, { onConflict: "telegram_id,tutorial_key" });
        await logEvent(tid, "tutorial_click", key);
      } else if (b.event === "done") {
        await supabase.from("tutorial_progress").upsert({ telegram_id: tid, tutorial_key: key, completato: true, updated_at: new Date().toISOString() }, { onConflict: "telegram_id,tutorial_key" });
        await logEvent(tid, "tutorial_completato", key);
      }
      return json({ ok: true });
    }

    // ----- MINI APP endpoints -----
    if (sub === "catalogo") {
      const { data } = await supabase.from("servizi").select("id, nome, descrizione, prezzo, categoria, tipo, risorse").eq("attivo", true).order("id");
      const cats: Record<string, any[]> = {};
      for (const s of data ?? []) { const c = (s as any).categoria || "Altro"; (cats[c] ||= []).push(s); }
      return json({ categorie: Object.entries(cats).map(([nome, servizi]) => ({ nome, servizi })) });
    }
    if (sub === "me") {
      const tid = await validateInitData(req.headers.get("x-telegram-init-data") || "");
      if (!tid) return json({ error: "unauthorized" }, 401);
      const { data: lead } = await supabase.from("leads").select("nome, username, pipeline_stage, sondaggio_completato").eq("telegram_id", tid).maybeSingle();
      const { data: sond } = await supabase.from("sondaggio_risposte").select("livello_trading, broker_usati, capitale, prodotto_preferito, willingness_to_pay").eq("telegram_id", tid).maybeSingle();
      const { data: prog } = await supabase.from("tutorial_progress").select("tutorial_key, completato").eq("telegram_id", tid);
      const { data: ls } = await supabase.from("lead_servizi").select("servizio_id, stato").eq("telegram_id", tid);
      let servizi: any[] = [];
      if (ls && ls.length) {
        const { data: serv } = await supabase.from("servizi").select("id, nome");
        const map: Record<number, string> = {};
        for (const s of serv ?? []) map[(s as any).id] = (s as any).nome;
        servizi = ls.map((x: any) => ({ nome: map[x.servizio_id] || "?", stato: x.stato }));
      }
      return json({ lead, sondaggio: sond, tutorial: prog ?? [], servizi });
    }
    if (sub === "delete-me") {
      const tid = await validateInitData(req.headers.get("x-telegram-init-data") || "");
      if (!tid) return json({ error: "unauthorized" }, 401);
      await deleteUserData(tid);
      return json({ ok: true });
    }
    if (sub === "attiva") {
      const tid = await validateInitData(req.headers.get("x-telegram-init-data") || "");
      if (!tid) return json({ error: "unauthorized" }, 401);
      const b = await req.json();
      const servizioId = parseInt(b.servizio_id);
      const now = new Date().toISOString();
      await supabase.from("leads").update({ interesse_at: now, pipeline_stage: "contattato", followup_livello: 0, ultimo_followup_at: null, ultimo_messaggio: now }).eq("telegram_id", tid);
      await logEvent(tid, "attiva_servizio", String(servizioId || ""));
      if (servizioId) {
        const { data: ex } = await supabase.from("lead_servizi").select("id").eq("telegram_id", tid).eq("servizio_id", servizioId).maybeSingle();
        if (!ex) await supabase.from("lead_servizi").insert({ telegram_id: tid, servizio_id: servizioId, stato: "interessato" });
      }
      const { data: lead } = await supabase.from("leads").select("username").eq("telegram_id", tid).maybeSingle();
      const uname = lead?.username ? "@" + lead.username : tid;
      let nomeServ = "";
      if (servizioId) { const { data: sv } = await supabase.from("servizi").select("nome").eq("id", servizioId).maybeSingle(); nomeServ = sv?.nome || ""; }
      try { await send(ADMIN_ID, `${uname} vuole attivare: ${nomeServ}`); } catch { /* */ }
      const ref = servizioId ? await resolveRefLink(tid, servizioId) : null;
      try { await send(tid, `Hai richiesto l'attivazione di ${nomeServ}. Ti ricontatto a breve di persona.`); } catch { /* */ }
      return json({ ok: true, ref_link: ref });
    }
    if (sub === "my-affiliate") {
      const tid = await validateInitData(req.headers.get("x-telegram-init-data") || "");
      if (!tid) return json({ error: "unauthorized" }, 401);
      const { data: links } = await supabase.from("affiliate_link").select("id, servizio_id, ref_link, approvato").eq("telegram_id", tid);
      const { data: serv } = await supabase.from("servizi").select("id, nome").eq("attivo", true).order("id");
      const map: Record<number, string> = {};
      for (const s of serv ?? []) map[(s as any).id] = (s as any).nome;
      const list = (links ?? []).map((l: any) => ({ ...l, nome: map[l.servizio_id] || "?" }));
      return json({ ref_url: `https://t.me/${BOT_USERNAME}?start=ref_${tid}`, links: list, servizi: serv ?? [] });
    }
    if (sub === "affiliate-request") {
      const tid = await validateInitData(req.headers.get("x-telegram-init-data") || "");
      if (!tid) return json({ error: "unauthorized" }, 401);
      const b = await req.json();
      const sid = parseInt(b.servizio_id);
      const link = (b.ref_link || "").trim();
      if (!sid || !link) return json({ ok: false });
      const { data: ex } = await supabase.from("affiliate_link").select("id").eq("telegram_id", tid).eq("servizio_id", sid).maybeSingle();
      if (ex) await supabase.from("affiliate_link").update({ ref_link: link, approvato: false }).eq("id", ex.id);
      else await supabase.from("affiliate_link").insert({ telegram_id: tid, servizio_id: sid, ref_link: link, approvato: false });
      await logEvent(tid, "affiliate_request", String(sid));
      const { data: lead } = await supabase.from("leads").select("username").eq("telegram_id", tid).maybeSingle();
      const { data: sv } = await supabase.from("servizi").select("nome").eq("id", sid).maybeSingle();
      try { await send(ADMIN_ID, `Richiesta affiliazione: ${lead?.username ? "@" + lead.username : tid} per ${sv?.nome || sid}\nLink: ${link}\nApprova dall'admin.`); } catch { /* */ }
      return json({ ok: true });
    }
    if (sub === "news") {
      const tid = await validateInitData(req.headers.get("x-telegram-init-data") || "");
      if (!tid) return json({ error: "unauthorized" }, 401);
      // SOLO servizi ATTIVI = canali a cui l'utente ha accesso
      const { data: ls } = await supabase.from("lead_servizi").select("servizio_id").eq("telegram_id", tid).eq("stato", "attivo");
      const activeIds = (ls ?? []).map((x: any) => x.servizio_id);
      const { data: serv } = await supabase.from("servizi").select("id, nome");
      const sMap: Record<number, string> = {}; for (const s of serv ?? []) sMap[(s as any).id] = (s as any).nome;
      const canali = [{ servizio_id: null, nome: "Generale" }, ...activeIds.map((id: number) => ({ servizio_id: id, nome: sMap[id] || "Servizio" }))];
      const { data: news } = await supabase.from("news").select("*").order("data", { ascending: false }).limit(100);
      const list = (news ?? []).filter((n: any) => n.servizio_id == null || activeIds.includes(n.servizio_id)).map((n: any) => ({ ...n, servizio: n.servizio_id ? (sMap[n.servizio_id] || "") : null }));
      return json({ canali, news: list });
    }

    const adminOk = req.headers.get("x-admin-key") === ADMIN_API_KEY;
    if (sub === "stats") { if (!adminOk) return json({ error: "unauthorized" }, 401); return json(await getStats()); }
    if (sub === "metrics") { if (!adminOk) return json({ error: "unauthorized" }, 401); return json(await getMetrics()); }
    if (sub === "leads") { if (!adminOk) return json({ error: "unauthorized" }, 401); const { data } = await supabase.from("leads").select("*").order("created_at", { ascending: false }); return json(data ?? []); }
    if (sub === "broadcast") { if (!adminOk) return json({ error: "unauthorized" }, 401); const { stage, text } = await req.json(); if (!stage || !text) return json({ error: "stage_and_text_required" }, 400); return json(await broadcast(stage, text)); }
    if (sub === "set-stage") { if (!adminOk) return json({ error: "unauthorized" }, 401); const { telegram_id, stage } = await req.json(); const patch: Record<string, unknown> = { pipeline_stage: stage, followup_livello: 0, ultimo_followup_at: null }; if (stage === "cliente") { patch.convertito_at = new Date().toISOString(); await logEvent(telegram_id, "convertito"); } await supabase.from("leads").update(patch).eq("telegram_id", telegram_id); return json({ success: true }); }
    if (sub === "servizi") { if (!adminOk) return json({ error: "unauthorized" }, 401); if (req.method === "GET") { const { data } = await supabase.from("servizi").select("*").order("id"); return json(data ?? []); } const b = await req.json(); const patch: Record<string, unknown> = { nome: b.nome, descrizione: b.descrizione, prezzo: b.prezzo, attivo: b.attivo }; if (b.categoria !== undefined) patch.categoria = b.categoria; if (b.link_principale !== undefined) patch.link_principale = b.link_principale; if (b.id) await supabase.from("servizi").update(patch).eq("id", b.id); else await supabase.from("servizi").insert({ ...patch, attivo: b.attivo ?? true }); return json({ success: true }); }
    if (sub === "servizi-del") { if (!adminOk) return json({ error: "unauthorized" }, 401); const { id } = await req.json(); await supabase.from("servizi").delete().eq("id", id); return json({ success: true }); }
    if (sub === "lead") { if (!adminOk) return json({ error: "unauthorized" }, 401); const tid = parseInt(url.searchParams.get("telegram_id") || "0"); return json(await getLeadCard(tid)); }
    if (sub === "lead-servizio") { if (!adminOk) return json({ error: "unauthorized" }, 401); const b = await req.json(); if (b.id) await supabase.from("lead_servizi").update({ stato: b.stato, note: b.note }).eq("id", b.id); else await supabase.from("lead_servizi").insert({ telegram_id: b.telegram_id, servizio_id: b.servizio_id, stato: b.stato ?? "interessato", note: b.note ?? null }); return json({ success: true }); }
    if (sub === "lead-servizio-del") { if (!adminOk) return json({ error: "unauthorized" }, 401); const { id } = await req.json(); await supabase.from("lead_servizi").delete().eq("id", id); return json({ success: true }); }
    if (sub === "nota") { if (!adminOk) return json({ error: "unauthorized" }, 401); const { telegram_id, testo } = await req.json(); await supabase.from("note").insert({ telegram_id, testo }); return json({ success: true }); }
    if (sub === "nota-del") { if (!adminOk) return json({ error: "unauthorized" }, 401); const { id } = await req.json(); await supabase.from("note").delete().eq("id", id); return json({ success: true }); }
    if (sub === "pagamento") {
      if (!adminOk) return json({ error: "unauthorized" }, 401);
      const b = await req.json();
      await supabase.from("pagamenti").insert({ telegram_id: b.telegram_id, servizio_id: b.servizio_id || null, importo: b.importo, nota: b.nota || null });
      return json({ success: true });
    }
    if (sub === "pagamento-del") { if (!adminOk) return json({ error: "unauthorized" }, 401); const { id } = await req.json(); await supabase.from("pagamenti").delete().eq("id", id); return json({ success: true }); }
    if (sub === "fatturato") {
      if (!adminOk) return json({ error: "unauthorized" }, 401);
      const { data: pag } = await supabase.from("pagamenti").select("servizio_id, importo, data");
      const { data: serv } = await supabase.from("servizi").select("id, nome");
      const sMap: Record<number, string> = {}; for (const s of serv ?? []) sMap[(s as any).id] = (s as any).nome;
      let totale = 0;
      const perServizio: Record<string, number> = {};
      const perMese: Record<string, number> = {};
      for (const p of pag ?? []) {
        const imp = Number((p as any).importo) || 0;
        totale += imp;
        const sn = sMap[(p as any).servizio_id] || "Altro";
        perServizio[sn] = (perServizio[sn] || 0) + imp;
        const mese = ((p as any).data || "").slice(0, 7);
        if (mese) perMese[mese] = (perMese[mese] || 0) + imp;
      }
      return json({ totale, pagamenti: (pag ?? []).length, perServizio, perMese });
    }
    if (sub === "affiliate-pending") {
      if (!adminOk) return json({ error: "unauthorized" }, 401);
      const { data: links } = await supabase.from("affiliate_link").select("*").order("created_at", { ascending: false });
      const { data: serv } = await supabase.from("servizi").select("id, nome");
      const { data: leads } = await supabase.from("leads").select("telegram_id, username, nome");
      const sMap: Record<number, string> = {}; for (const s of serv ?? []) sMap[(s as any).id] = (s as any).nome;
      const lMap: Record<number, any> = {}; for (const l of leads ?? []) lMap[(l as any).telegram_id] = l;
      return json((links ?? []).map((x: any) => ({ ...x, servizio: sMap[x.servizio_id] || "?", username: lMap[x.telegram_id]?.username || null, nome: lMap[x.telegram_id]?.nome || null })));
    }
    if (sub === "affiliate-approve") {
      if (!adminOk) return json({ error: "unauthorized" }, 401);
      const { id, approvato } = await req.json();
      await supabase.from("affiliate_link").update({ approvato: !!approvato }).eq("id", id);
      const { data: al } = await supabase.from("affiliate_link").select("telegram_id, servizio_id").eq("id", id).maybeSingle();
      if (al && approvato) { try { await send(al.telegram_id, "Il tuo link affiliato e stato approvato. Ora chi entra dal tuo link e attiva quel servizio userà il tuo ref."); } catch { /* */ } }
      return json({ ok: true });
    }
    if (sub === "news-post") {
      if (!adminOk) return json({ error: "unauthorized" }, 401);
      const b = await req.json();
      await supabase.from("news").insert({ servizio_id: b.servizio_id || null, titolo: b.titolo || null, testo: b.testo || null, immagine: b.immagine || null });
      return json({ success: true });
    }
    if (sub === "news-admin") {
      if (!adminOk) return json({ error: "unauthorized" }, 401);
      const { data: news } = await supabase.from("news").select("*").order("data", { ascending: false });
      const { data: serv } = await supabase.from("servizi").select("id, nome");
      const sMap: Record<number, string> = {}; for (const s of serv ?? []) sMap[(s as any).id] = (s as any).nome;
      return json((news ?? []).map((n: any) => ({ ...n, servizio: n.servizio_id ? (sMap[n.servizio_id] || "") : "Generale" })));
    }
    if (sub === "news-del") {
      if (!adminOk) return json({ error: "unauthorized" }, 401);
      const { id } = await req.json();
      await supabase.from("news").delete().eq("id", id);
      return json({ success: true });
    }
    return json({ service: "businessup-bot", status: "ok" });
  } catch (e) {
    console.error("Error:", e);
    return json({ error: String(e) }, 500);
  }
});
