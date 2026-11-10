import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../server.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let database;
let server;
let baseUrl;
const adminEmail = "billing-admin@example.com";
const pngReceipt = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/LbcAAAAASUVORK5CYII=", "base64");

beforeEach(async () => {
  database = new PGlite();
  await database.exec(await readFile(path.join(root, "db", "schema.sql"), "utf8"));
  server = createApp(database).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (database) await database.close();
});

async function request(pathname, { method = "GET", cookie = "", body, origin = "http://localhost:3000" } = {}) {
  const headers = { origin };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = response.status === 204 ? null : await response.json();
  return { response, result };
}

async function register(role, email) {
  const { response, result } = await request("/api/auth/register", {
    method: "POST",
    body: { role, email, password: "uma-senha-segura-123" }
  });
  assert.equal(response.status, 201);
  return { id: result.user.id, cookie: response.headers.get("set-cookie").split(";")[0] };
}

async function publishDoula(email = "doula@example.com", overrides = {}) {
  const user = await register("doula", email);
  const { response } = await request("/api/profile", {
    method: "PUT",
    cookie: user.cookie,
    body: {
      name: "Ana Doula",
      city: "Recife",
      neighborhood: "Boa Viagem",
      about: "Acolhimento e informação para sua jornada.",
      services: ["parto", "gestacao"],
      serviceMode: "Presencial e online",
      experienceYears: 6,
      priceCents: 52000,
      paymentUrl: "https://pagamentos.example/ana",
      published: true,
      ...overrides
    }
  });
  assert.equal(response.status, 200);
  return user;
}

async function uploadReceipt(cookie, { data = pngReceipt, type = "image/png", filename = "comprovante.png", plan = "standard" } = {}) {
  const form = new FormData();
  form.append("plan", plan);
  form.append("proof", new Blob([data], { type }), filename);
  const response = await fetch(`${baseUrl}/api/billing/proof`, {
    method: "POST",
    headers: { origin: "http://localhost:3000", cookie },
    body: form
  });
  return { response, result: await response.json() };
}

async function approveDoula(doula) {
  process.env.ADMIN_EMAILS = adminEmail;
  const admin = await register("gestante", adminEmail);
  const uploaded = await uploadReceipt(doula.cookie);
  assert.equal(uploaded.response.status, 201);
  const reviewed = await request(`/api/admin/payments/${uploaded.result.id}/review`, {
    method: "POST",
    cookie: admin.cookie,
    body: { decision: "approved" }
  });
  assert.equal(reviewed.response.status, 200);
  return { admin, submissionId: uploaded.result.id };
}

afterEach(() => {
  delete process.env.ADMIN_EMAILS;
});

test("health check and homepage are served by the application", async () => {
  const health = await request("/api/health");
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.result, { status: "ok" });

  const homepage = await fetch(baseUrl);
  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), /colodoula|doulas perto de você/i);
});

test("registration creates a persistent login session and login rejects incorrect passwords", async () => {
  const { response, result } = await request("/api/auth/register", {
    method: "POST",
    body: { role: "gestante", email: "login@example.com", password: "uma-senha-segura-123" }
  });
  assert.equal(response.status, 201);
  assert.equal(result.user.email, "login@example.com");
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);

  const login = await request("/api/auth/login", {
    method: "POST",
    body: { email: "login@example.com", password: "uma-senha-segura-123" }
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get("set-cookie").split(";")[0];
  const profile = await request("/api/me", { cookie });
  assert.equal(profile.result.user.id, result.user.id);

  const incorrect = await request("/api/auth/login", {
    method: "POST",
    body: { email: "login@example.com", password: "senha-incorreta-123" }
  });
  assert.equal(incorrect.response.status, 401);
  assert.equal(incorrect.result.error, "E-mail ou senha incorretos.");
});

test("accounts keep gestational information private from public doula search", async () => {
  const gestante = await register("gestante", "gestante@example.com");
  const saved = await request("/api/profile", {
    method: "PUT",
    cookie: gestante.cookie,
    body: {
      name: "Pessoa Gestante",
      city: "Recife",
      neighborhood: "Centro",
      about: "Busco escuta",
      pregnancyWeeks: 24,
      dueDate: "2027-03-01",
      preferences: "Apoio no parto"
    }
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.result.profile.pregnancyWeeks, 24);
  assert.equal(saved.result.profile.preferences, "Apoio no parto");

  await publishDoula();
  const search = await request("/api/doulas?city=Recife&service=parto");
  assert.equal(search.response.status, 200);
  assert.equal(search.result.doulas.length, 1);
  assert.equal(search.result.doulas[0].name, "Ana Doula");
  assert.equal(JSON.stringify(search.result).includes("Pessoa Gestante"), false);
  assert.equal(JSON.stringify(search.result).includes("Apoio no parto"), false);
});

test("published doulas appear only after choosing to publish, and payment URLs require HTTPS", async () => {
  const doula = await register("doula", "private@example.com");
  const draft = await request("/api/profile", {
    method: "PUT",
    cookie: doula.cookie,
    body: {
      name: "Rascunho",
      city: "Recife",
      about: "Atendimento acolhedor",
      services: ["gestacao"],
      published: false
    }
  });
  assert.equal(draft.response.status, 200);
  assert.equal((await request("/api/doulas")).result.doulas.length, 0);

  const invalidPayment = await request("/api/profile", {
    method: "PUT",
    cookie: doula.cookie,
    body: {
      name: "Rascunho",
      city: "Recife",
      about: "Atendimento acolhedor",
      services: ["gestacao"],
      paymentUrl: "javascript:alert(1)",
      published: true
    }
  });
  assert.equal(invalidPayment.response.status, 400);
});

test("active premium doulas lead recommended search without overriding explicit sorting", async () => {
  const standard = await publishDoula("standard@example.com", { name: "Plano Padrão", priceCents: 30000 });
  const premium = await publishDoula("premium@example.com", { name: "Plano Premium", priceCents: 60000 });
  process.env.ADMIN_EMAILS = adminEmail;
  const admin = await register("gestante", adminEmail);
  const upload = await uploadReceipt(premium.cookie, { plan: "premium" });
  assert.equal(upload.response.status, 201);
  assert.equal(upload.result.amountCents, 5990);

  const queue = await request("/api/admin/payments", { cookie: admin.cookie });
  assert.equal(queue.result.submissions[0].plan, "premium");
  assert.equal(queue.result.submissions[0].amount_cents, 5990);
  const reviewed = await request(`/api/admin/payments/${upload.result.id}/review`, {
    method: "POST",
    cookie: admin.cookie,
    body: { decision: "approved" }
  });
  assert.equal(reviewed.response.status, 200);

  const billing = await request("/api/billing", { cookie: premium.cookie });
  assert.equal(billing.result.plans.standard.amountCents, 3990);
  assert.equal(billing.result.plans.premium.amountCents, 5990);
  assert.equal(billing.result.premiumActive, true);

  const recommended = await request("/api/doulas");
  assert.deepEqual(recommended.result.doulas.map((doula) => doula.name), ["Plano Premium", "Plano Padrão"]);
  assert.equal(recommended.result.doulas[0].isPremium, true);
  assert.equal(recommended.result.doulas[1].isPremium, false);

  const priceLow = await request("/api/doulas?sort=price-low");
  assert.deepEqual(priceLow.result.doulas.map((doula) => doula.name), ["Plano Padrão", "Plano Premium"]);
  assert.equal((await request("/api/billing", { cookie: standard.cookie })).result.premiumActive, false);
});

test("only conversation participants can read or send messages", async () => {
  const doula = await publishDoula();
  await approveDoula(doula);
  const gestante = await register("gestante", "contato@example.com");
  const stranger = await register("gestante", "outra@example.com");
  const profiles = await request("/api/doulas");
  const doulaId = profiles.result.doulas[0].id;

  const started = await request("/api/conversations", {
    method: "POST",
    cookie: gestante.cookie,
    body: { doulaId, message: "Olá, gostaria de conhecer seu trabalho." }
  });

  assert.equal(started.response.status, 201);
  const conversationId = started.result.conversationId;

  const reply = await request(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    cookie: doula.cookie,
    body: { message: "Olá! Podemos conversar." }
  });
  assert.equal(reply.response.status, 201);

  const messages = await request(`/api/conversations/${conversationId}/messages`, { cookie: gestante.cookie });
  assert.equal(messages.result.messages.length, 2);
  assert.equal(messages.result.messages[0].body, "Olá, gostaria de conhecer seu trabalho.");

  const forbidden = await request(`/api/conversations/${conversationId}/messages`, { cookie: stranger.cookie });
  assert.equal(forbidden.response.status, 404);
});

test("receipt upload never unlocks contacts before admin confirms the payment", async () => {
  const doula = await register("doula", "billing-doula@example.com");
  const initial = await request("/api/billing", { cookie: doula.cookie });
  assert.equal(initial.response.status, 200);
  assert.equal(initial.result.amountCents, 3990);
  assert.equal(initial.result.status, "unpaid");

  const invalidImage = await uploadReceipt(doula.cookie, {
    data: Buffer.from("not an image"),
    type: "image/png"
  });
  assert.equal(invalidImage.response.status, 400);

  const upload = await uploadReceipt(doula.cookie);
  assert.equal(upload.response.status, 201);
  assert.equal(upload.result.status, "pending");

  const pending = await request("/api/billing", { cookie: doula.cookie });
  assert.equal(pending.result.status, "pending");
  assert.equal(pending.result.accessActive, false);
  assert.equal((await request("/api/contacts", { cookie: doula.cookie })).response.status, 402);
  assert.equal((await request("/api/conversations", { cookie: doula.cookie })).response.status, 402);
  assert.equal((await uploadReceipt(doula.cookie)).response.status, 409);
  assert.equal((await request("/api/admin/payments")).response.status, 401);

  const rejectedAdmin = await register("gestante", "not-an-admin@example.com");
  const forbiddenReview = await request(`/api/admin/payments/${upload.result.id}/review`, {
    method: "POST",
    cookie: rejectedAdmin.cookie,
    body: { decision: "approved" }
  });
  assert.equal(forbiddenReview.response.status, 403);

  process.env.ADMIN_EMAILS = adminEmail;
  const admin = await register("gestante", adminEmail);
  const queue = await request("/api/admin/payments", { cookie: admin.cookie });
  assert.equal(queue.response.status, 200);
  assert.equal(queue.result.submissions.length, 1);
  const image = await fetch(`${baseUrl}/api/admin/payments/${upload.result.id}/proof`, {
    headers: { cookie: admin.cookie }
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");

  const reviewed = await request(`/api/admin/payments/${upload.result.id}/review`, {
    method: "POST",
    cookie: admin.cookie,
    body: { decision: "approved" }
  });
  assert.equal(reviewed.response.status, 200);
  const access = await request("/api/billing", { cookie: doula.cookie });
  assert.equal(access.result.status, "approved");
  assert.equal(access.result.accessActive, true);
  assert.ok(new Date(access.result.accessUntil).getTime() > Date.now());
  const deletedImage = await fetch(`${baseUrl}/api/admin/payments/${upload.result.id}/proof`, {
    headers: { cookie: admin.cookie }
  });
  assert.equal(deletedImage.status, 404);
});

test("the paid directory exposes only contacts whose owners opted in, never gestational details", async () => {
  const doula = await publishDoula("directory-doula@example.com");
  await approveDoula(doula);
  const shared = await register("gestante", "shared@example.com");
  const directoryOnly = await register("gestante", "private-email@example.com");
  const privateProfile = await register("gestante", "private@example.com");
  const saveGestante = async (user, consents) => request("/api/profile", {
    method: "PUT",
    cookie: user.cookie,
    body: {
      name: user === shared ? "Pessoa Compartilhada" : "Pessoa Privada",
      city: "Recife",
      neighborhood: "Boa Viagem",
      pregnancyWeeks: 24,
      preferences: "Dado privado de gestação",
      ...consents
    }
  });
  assert.equal((await saveGestante(shared, { directoryOptIn: true, contactSharingOptIn: true })).response.status, 200);
  assert.equal((await saveGestante(directoryOnly, { directoryOptIn: true, contactSharingOptIn: false })).response.status, 200);
  assert.equal((await saveGestante(privateProfile, { directoryOptIn: false, contactSharingOptIn: false })).response.status, 200);

  const contacts = await request("/api/contacts?city=Recife", { cookie: doula.cookie });
  assert.equal(contacts.response.status, 200);
  assert.equal(contacts.result.contacts.length, 1);
  assert.equal(contacts.result.contacts[0].email, "shared@example.com");
  assert.deepEqual(Object.keys(contacts.result.contacts[0]).sort(), ["city", "email", "id", "name", "neighborhood"]);

  const invalidConsent = await request("/api/profile", {
    method: "PUT",
    cookie: privateProfile.cookie,
    body: {
      name: "Pessoa Privada",
      city: "Recife",
      directoryOptIn: false,
      contactSharingOptIn: true
    }
  });
  assert.equal(invalidConsent.response.status, 400);

  await saveGestante(shared, { directoryOptIn: false, contactSharingOptIn: false });
  const revoked = await request("/api/contacts", { cookie: doula.cookie });
  assert.equal(revoked.result.contacts.length, 0);
});

test("state-changing requests reject unexpected origins and protected routes require login", async () => {
  const forbidden = await request("/api/auth/register", {
    method: "POST",
    origin: "https://example.org",
    body: { role: "gestante", email: "gestante@example.com", password: "uma-senha-segura-123" }
  });
  assert.equal(forbidden.response.status, 403);

  const unauthenticated = await request("/api/profile", {
    method: "PUT",
    body: { name: "Pessoa", city: "Recife" }
  });
  assert.equal(unauthenticated.response.status, 401);

  const missingBody = await request("/api/auth/register", {
    method: "POST",
    body: undefined
  });
  assert.equal(missingBody.response.status, 415);

  const malformedCookie = await request("/api/me", { cookie: "colo_session=%zz" });
  assert.equal(malformedCookie.response.status, 401);
});
