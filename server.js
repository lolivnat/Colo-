import "dotenv/config";
import { randomBytes, randomUUID, scrypt as scryptCallback, createHash, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import pg from "pg";

const { Pool } = pg;
const scrypt = promisify(scryptCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
const sessionCookie = "colo_session";
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000;
const services = new Set(["parto", "gestacao", "pos-parto", "online"]);
const appOrigin = process.env.APP_ORIGIN || "http://localhost:3000";
const billingPlans = {
  standard: { amountCents: 3990, environmentVariable: "PAYMENT_CHECKOUT_URL" },
  premium: { amountCents: 5990, environmentVariable: "PREMIUM_PAYMENT_CHECKOUT_URL" }
};
const receiptUploadLimitBytes = 4 * 1024 * 1024;
const uploadReceipt = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: receiptUploadLimitBytes, files: 1, fields: 1 }
});

function isAdminEmail(email) {
  const admins = (process.env.ADMIN_EMAILS || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return admins.includes(email.toLowerCase());
}

function detectImageMime(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff &&
    buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9) return "image/jpeg";
  if (buffer.length >= 45 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    buffer.readUInt32BE(8) === 13 && buffer.toString("ascii", 12, 16) === "IHDR" &&
    buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(20) > 0 &&
    buffer.subarray(-12, -8).equals(Buffer.from([0, 0, 0, 0])) && buffer.toString("ascii", buffer.length - 8, buffer.length - 4) === "IEND") return "image/png";
  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.readUInt32LE(4) === buffer.length - 8 && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "";
}

function safeCheckoutUrl(environmentVariable = "PAYMENT_CHECKOUT_URL") {
  const value = process.env[environmentVariable];
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${environmentVariable} precisa ser um link HTTPS válido.`);
  }
  if (url.protocol !== "https:") throw new Error(`${environmentVariable} precisa começar com https://.`);
  return url.toString();
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeEmail(value) {
  if (typeof value !== "string" || value.length > 254) throw new HttpError(400, "Informe um e-mail válido.");
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Informe um e-mail válido.");
  return email;
}

function readCookie(request, name) {
  const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!cookie) return "";
  try {
    return decodeURIComponent(cookie.slice(name.length + 1));
  } catch {
    return "";
  }
}

function tokenDigest(token) {
  return createHash("sha256").update(token).digest("hex");
}

function cookieOptions() {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionDurationMs / 1000}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

function isAllowedOrigin(origin) {
  if (origin === appOrigin) return true;
  if (process.env.NODE_ENV === "production") return false;
  try {
    const expected = new URL(appOrigin);
    const actual = new URL(origin);
    const localHosts = new Set(["localhost", "127.0.0.1"]);
    return expected.protocol === "http:" && actual.protocol === "http:" &&
      localHosts.has(expected.hostname) && localHosts.has(actual.hostname) &&
      expected.port === actual.port;
  } catch {
    return false;
  }
}

function writeSession(response, token) {
  response.setHeader("Set-Cookie", `${sessionCookie}=${encodeURIComponent(token)}; ${cookieOptions()}`);
}

function clearSession(response) {
  response.setHeader("Set-Cookie", `${sessionCookie}=; ${cookieOptions().replace(`Max-Age=${sessionDurationMs / 1000}`, "Max-Age=0")}`);
}

function requireText(value, label, maxLength, { required = false } = {}) {
  if (typeof value !== "string") {
    if (!required && value == null) return "";
    throw new HttpError(400, `O campo ${label} é inválido.`);
  }
  const text = value.trim();
  if ((required && !text) || text.length > maxLength) throw new HttpError(400, `Confira o campo ${label}.`);
  return text;
}

function parseProfile(body, role) {
  const name = requireText(body.name, "nome", 80, { required: true });
  const city = requireText(body.city, "cidade", 100, { required: true });
  const neighborhood = requireText(body.neighborhood ?? "", "bairro", 100);
  const about = requireText(body.about ?? "", "sobre", 600);

  if (role === "doula") {
    if (!Array.isArray(body.services) || body.services.length > services.size ||
      new Set(body.services).size !== body.services.length ||
      body.services.some((service) => typeof service !== "string" || !services.has(service))) {
      throw new HttpError(400, "Selecione serviços válidos.");
    }
    if (body.published === true && (!about || body.services.length === 0)) {
      throw new HttpError(400, "Para publicar seu perfil, informe uma apresentação e pelo menos um serviço.");
    }

    let paymentUrl = null;
    if (body.paymentUrl) {
      const rawUrl = requireText(body.paymentUrl, "link de pagamento", 500);
      let parsedUrl;
      try {
        parsedUrl = new URL(rawUrl);
      } catch {
        throw new HttpError(400, "Informe um link de pagamento válido.");
      }
      if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname) {
        throw new HttpError(400, "O link de pagamento precisa começar com https://.");
      }
      paymentUrl = parsedUrl.toString();
    }

    const experienceYears = body.experienceYears === "" || body.experienceYears == null ? null : Number(body.experienceYears);
    const priceCents = body.priceCents === "" || body.priceCents == null ? null : Number(body.priceCents);
    if (experienceYears !== null && (!Number.isInteger(experienceYears) || experienceYears < 0 || experienceYears > 80)) {
      throw new HttpError(400, "Informe anos de experiência entre 0 e 80.");
    }
    if (priceCents !== null && (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 100_000_000)) {
      throw new HttpError(400, "Informe um valor válido.");
    }

    return {
      name, city, neighborhood, about, services: body.services,
      serviceMode: requireText(body.serviceMode ?? "", "tipo de atendimento", 120),
      experienceYears, priceCents, paymentUrl, published: body.published === true,
      pregnancyWeeks: null, dueDate: null, preferences: "",
      directoryOptIn: false, contactSharingOptIn: false
    };
  }

  const pregnancyWeeks = body.pregnancyWeeks === "" || body.pregnancyWeeks == null ? null : Number(body.pregnancyWeeks);
  if (pregnancyWeeks !== null && (!Number.isInteger(pregnancyWeeks) || pregnancyWeeks < 1 || pregnancyWeeks > 45)) {
    throw new HttpError(400, "Informe semanas de gestação entre 1 e 45.");
  }
  const dueDate = requireText(body.dueDate ?? "", "data prevista", 10);
  if (dueDate) {
    const parsedDate = new Date(`${dueDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== dueDate) {
      throw new HttpError(400, "Informe uma data prevista válida.");
    }
  }
  const directoryOptIn = body.directoryOptIn === true;
  const contactSharingOptIn = body.contactSharingOptIn === true;
  if (contactSharingOptIn && !directoryOptIn) {
    throw new HttpError(400, "Para compartilhar seu e-mail, primeiro escolha aparecer no diretório de doulas.");
  }
  return {
    name, city, neighborhood, about, services: [],
    serviceMode: "", experienceYears: null, priceCents: null, paymentUrl: null, published: false,
    pregnancyWeeks, dueDate: dueDate || null,
    preferences: requireText(body.preferences ?? "", "preferências", 400),
    directoryOptIn, contactSharingOptIn
  };
}

function mapProfile(row, role) {
  if (!row) return null;
  const base = {
    name: row.name,
    city: row.city,
    neighborhood: row.neighborhood,
    about: row.about
  };
  if (role === "doula") {
    return {
      ...base,
      services: row.services,
      serviceMode: row.service_mode,
      experienceYears: row.experience_years,
      priceCents: row.price_cents,
      paymentUrl: row.payment_url,
      published: row.published
    };
  }
  return {
    ...base,
    pregnancyWeeks: row.pregnancy_weeks,
    dueDate: row.due_date,
    preferences: row.preferences,
    directoryOptIn: row.directory_opt_in,
    contactSharingOptIn: row.contact_sharing_opt_in
  };
}

export function createApp(pool) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        upgradeInsecureRequests: null
      }
    },
    crossOriginEmbedderPolicy: false
  }));
  app.use(express.json({ limit: "32kb", strict: true }));
  app.use((request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.static(path.join(root, "public")));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Muitas tentativas. Aguarde alguns minutos e tente novamente." }
  });

  app.use("/api", (request, response, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && !isAllowedOrigin(request.get("origin"))) {
      return response.status(403).json({ error: "Origem não autorizada." });
    }
    if (["POST", "PUT", "PATCH"].includes(request.method) && request.path !== "/auth/logout" && request.path !== "/billing/proof") {
      if (!request.is("application/json")) return response.status(415).json({ error: "Envie os dados em formato JSON." });
      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
        return response.status(400).json({ error: "Informe os dados da solicitação." });
      }
    }
    next();
  });

  async function authenticate(request, response, next) {
    const token = readCookie(request, sessionCookie);
    if (!token || token.length > 128) return response.status(401).json({ error: "Entre na sua conta para continuar." });
    try {
      const result = await pool.query(
        `SELECT u.id, u.email, u.role, p.name
         FROM sessions s JOIN users u ON u.id = s.user_id
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [tokenDigest(token)]
      );
      if (!result.rows[0]) return response.status(401).json({ error: "Sua sessão expirou. Entre novamente." });
      request.user = result.rows[0];
      next();
    } catch (error) {
      next(error);
    }
  }

  async function hasPaidContactAccess(userId) {
    const result = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM billing_submissions
         WHERE doula_id = $1 AND status = 'approved' AND access_until > now()
       ) AS active`,
      [userId]
    );
    return result.rows[0].active;
  }

  function requireAdmin(request, response, next) {
    if (!isAdminEmail(request.user.email)) return response.status(403).json({ error: "Acesso restrito à equipe administrativa." });
    next();
  }

  function requireDoula(request, response, next) {
    if (request.user.role !== "doula") return response.status(403).json({ error: "Este recurso é exclusivo para doulas." });
    next();
  }

  async function requirePaidDoula(request, response, next) {
    if (request.user.role !== "doula") return response.status(403).json({ error: "Este recurso é exclusivo para doulas." });
    try {
      if (!(await hasPaidContactAccess(request.user.id))) {
        return response.status(402).json({ error: "Acesso aos contatos bloqueado. Envie o comprovante mensal de R$ 39,90 e aguarde a confirmação do pagamento." });
      }
      next();
    } catch (error) {
      next(error);
    }
  }

  app.get("/api/health", async (_request, response, next) => {
    try {
      await pool.query("SELECT 1");
      response.json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/register", authLimiter, async (request, response, next) => {
    try {
      const email = normalizeEmail(request.body.email);
      const password = request.body.password;
      const role = request.body.role;
      if (typeof password !== "string" || password.length < 12 || password.length > 128) {
        throw new HttpError(400, "A senha deve ter entre 12 e 128 caracteres.");
      }
      if (!["doula", "gestante"].includes(role)) throw new HttpError(400, "Selecione doula ou gestante.");

      const salt = randomBytes(16);
      const derivedKey = await scrypt(password, salt, 64);
      const passwordHash = `scrypt$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
      const userId = randomUUID();
      await pool.query("INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, $4)", [userId, email, passwordHash, role]);
      await pool.query(
        `INSERT INTO profiles (user_id, name, city, published) VALUES ($1, $2, $3, false)`,
        [userId, "Perfil novo", "A definir"]
      );
      const token = randomBytes(32).toString("base64url");
      await pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '7 days')", [tokenDigest(token), userId]);
      writeSession(response, token);
      response.status(201).json({ user: { id: userId, email, role }, needsProfile: true });
    } catch (error) {
      if (error.code === "23505") return response.status(409).json({ error: "Já existe uma conta com este e-mail." });
      next(error);
    }
  });

  app.post("/api/auth/login", authLimiter, async (request, response, next) => {
    try {
      const email = normalizeEmail(request.body.email);
      const password = request.body.password;
      if (typeof password !== "string" || password.length > 128) throw new HttpError(400, "Confira seu e-mail e sua senha.");
      const result = await pool.query("SELECT id, email, role, password_hash FROM users WHERE email = $1", [email]);
      const user = result.rows[0];
      const [scheme, saltHex, hashHex] = user?.password_hash.split("$") || [];
      const hasValidHash = scheme === "scrypt" && /^[\da-f]{32}$/i.test(saltHex) && /^[\da-f]{128}$/i.test(hashHex);
      const salt = hasValidHash ? Buffer.from(saltHex, "hex") : Buffer.alloc(16, 17);
      const expected = hasValidHash ? Buffer.from(hashHex, "hex") : Buffer.alloc(64);
      const actual = await scrypt(password, salt, 64);
      const valid = Boolean(user && hasValidHash && timingSafeEqual(actual, expected));
      if (!valid) throw new HttpError(401, "E-mail ou senha incorretos.");
      const token = randomBytes(32).toString("base64url");
      await pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '7 days')", [tokenDigest(token), user.id]);
      writeSession(response, token);
      response.json({ user: { id: user.id, email: user.email, role: user.role } });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/logout", authenticate, async (request, response, next) => {
    try {
      await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenDigest(readCookie(request, sessionCookie))]);
      clearSession(response);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/me", authenticate, async (request, response, next) => {
    try {
      const result = await pool.query("SELECT * FROM profiles WHERE user_id = $1", [request.user.id]);
      response.json({
        user: { id: request.user.id, email: request.user.email, role: request.user.role, isAdmin: isAdminEmail(request.user.email) },
        profile: mapProfile(result.rows[0], request.user.role)
      });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/profile", authenticate, async (request, response, next) => {
    try {
      const profile = parseProfile(request.body, request.user.role);
      const result = await pool.query(
        `INSERT INTO profiles (
           user_id, name, city, neighborhood, about, services, service_mode,
           experience_years, price_cents, payment_url, published,
           pregnancy_weeks, due_date, preferences, directory_opt_in,
           contact_sharing_opt_in, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now())
         ON CONFLICT (user_id) DO UPDATE SET
           name = EXCLUDED.name, city = EXCLUDED.city, neighborhood = EXCLUDED.neighborhood,
           about = EXCLUDED.about, services = EXCLUDED.services, service_mode = EXCLUDED.service_mode,
           experience_years = EXCLUDED.experience_years, price_cents = EXCLUDED.price_cents,
           payment_url = EXCLUDED.payment_url, published = EXCLUDED.published,
           pregnancy_weeks = EXCLUDED.pregnancy_weeks, due_date = EXCLUDED.due_date,
           preferences = EXCLUDED.preferences, directory_opt_in = EXCLUDED.directory_opt_in,
           contact_sharing_opt_in = EXCLUDED.contact_sharing_opt_in, updated_at = now()
         RETURNING *`,
        [request.user.id, profile.name, profile.city, profile.neighborhood, profile.about, profile.services, profile.serviceMode, profile.experienceYears, profile.priceCents, profile.paymentUrl, profile.published, profile.pregnancyWeeks, profile.dueDate, profile.preferences, profile.directoryOptIn, profile.contactSharingOptIn]
      );
      response.json({ profile: mapProfile(result.rows[0], request.user.role) });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/account", authenticate, async (request, response, next) => {
    try {
      await pool.query("DELETE FROM users WHERE id = $1", [request.user.id]);
      clearSession(response);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/billing", authenticate, requireDoula, async (request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT id, plan, status, submitted_at, reviewed_at, review_note, access_until,
                EXISTS (
                  SELECT 1 FROM billing_submissions active
                  WHERE active.doula_id = $1 AND active.status = 'approved' AND active.access_until > now()
                ) AS access_active,
                EXISTS (
                  SELECT 1 FROM billing_submissions active
                  WHERE active.doula_id = $1 AND active.status = 'approved' AND active.plan = 'premium' AND active.access_until > now()
                ) AS premium_active
         FROM billing_submissions
         WHERE doula_id = $1
         ORDER BY submitted_at DESC
         LIMIT 1`,
        [request.user.id]
      );
      const latest = result.rows[0] || null;
      response.json({
        amountCents: billingPlans.standard.amountCents,
        paymentUrl: safeCheckoutUrl(),
        plans: Object.fromEntries(Object.entries(billingPlans).map(([id, plan]) => [id, {
          amountCents: plan.amountCents,
          paymentUrl: safeCheckoutUrl(plan.environmentVariable)
        }])),
        plan: latest?.plan || "standard",
        status: latest?.status || "unpaid",
        submittedAt: latest?.submitted_at || null,
        reviewedAt: latest?.reviewed_at || null,
        reviewNote: latest?.review_note || null,
        accessActive: latest?.access_active || false,
        premiumActive: latest?.premium_active || false,
        accessUntil: latest?.access_until || null,
        canSubmitProof: !latest || latest.status !== "pending"
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/billing/proof", authenticate, requireDoula, uploadReceipt.single("proof"), async (request, response, next) => {
    try {
      const plan = request.body.plan || "standard";
      if (!Object.hasOwn(billingPlans, plan)) throw new HttpError(400, "Selecione um plano válido.");
      if (!request.file) throw new HttpError(400, "Selecione uma imagem do comprovante.");
      const actualMime = detectImageMime(request.file.buffer);
      if (!actualMime || actualMime !== request.file.mimetype) {
        throw new HttpError(400, "Envie uma imagem JPEG, PNG ou WebP válida.");
      }

      const pending = await pool.query(
        "SELECT id FROM billing_submissions WHERE doula_id = $1 AND status = 'pending'",
        [request.user.id]
      );
      if (pending.rows[0]) throw new HttpError(409, "Seu comprovante já está em análise. Aguarde a equipe confirmar o pagamento.");

      const id = randomUUID();
      await pool.query(
        `INSERT INTO billing_submissions (id, doula_id, plan, amount_cents, status, proof_image, proof_mime)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
        [id, request.user.id, plan, billingPlans[plan].amountCents, request.file.buffer, actualMime]
      );
      response.status(201).json({
        id,
        plan,
        amountCents: billingPlans[plan].amountCents,
        status: "pending",
        submittedAt: new Date().toISOString()
      });
    } catch (error) {
      if (error.code === "23505") return response.status(409).json({ error: "Seu comprovante já está em análise. Aguarde a equipe confirmar o pagamento." });
      next(error);
    }
  });

  app.get("/api/admin/payments", authenticate, requireAdmin, async (_request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT b.id, b.plan, b.amount_cents, b.submitted_at, b.proof_mime,
                u.email, p.name, p.city
         FROM billing_submissions b
         JOIN users u ON u.id = b.doula_id
         LEFT JOIN profiles p ON p.user_id = b.doula_id
         WHERE b.status = 'pending'
         ORDER BY b.submitted_at ASC
         LIMIT 100`
      );
      response.json({ submissions: result.rows });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin/payments/:id/proof", authenticate, requireAdmin, async (request, response, next) => {
    if (!/^[0-9a-f-]{36}$/i.test(request.params.id)) return response.status(404).json({ error: "Comprovante não encontrado." });
    try {
      const result = await pool.query(
        "SELECT proof_image, proof_mime FROM billing_submissions WHERE id = $1 AND status = 'pending'",
        [request.params.id]
      );
      const submission = result.rows[0];
      if (!submission?.proof_image) return response.status(404).json({ error: "Comprovante não encontrado ou já analisado." });
      response.setHeader("Content-Type", submission.proof_mime);
      response.setHeader("Content-Disposition", 'inline; filename="comprovante-pagamento"');
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.end(submission.proof_image);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/payments/:id/review", authenticate, requireAdmin, async (request, response, next) => {
    if (!/^[0-9a-f-]{36}$/i.test(request.params.id)) return response.status(404).json({ error: "Comprovante não encontrado." });
    try {
      const decision = request.body.decision;
      if (!["approved", "rejected"].includes(decision)) throw new HttpError(400, "Escolha aprovar ou rejeitar o comprovante.");
      const note = requireText(request.body.note ?? "", "observação", 500);
      if (decision === "rejected" && !note) throw new HttpError(400, "Informe o motivo da rejeição para orientar a doula.");

      const result = decision === "approved"
        ? await pool.query(
          `UPDATE billing_submissions b SET
             status = 'approved',
             proof_image = NULL,
             proof_mime = NULL,
             reviewed_at = now(),
             reviewer_id = $2,
             review_note = COALESCE(NULLIF($3, ''), 'Pagamento confirmado.'),
             access_until = COALESCE((
               SELECT max(previous.access_until) FROM billing_submissions previous
               WHERE previous.doula_id = b.doula_id AND previous.status = 'approved' AND previous.access_until > now()
             ), now()) + interval '30 days'
           WHERE b.id = $1 AND b.status = 'pending'
           RETURNING id, status, access_until`,
          [request.params.id, request.user.id, note]
        )
        : await pool.query(
          `UPDATE billing_submissions SET
             status = 'rejected',
             proof_image = NULL,
             proof_mime = NULL,
             reviewed_at = now(),
             reviewer_id = $2,
             review_note = $3
           WHERE id = $1 AND status = 'pending'
           RETURNING id, status, access_until`,
          [request.params.id, request.user.id, note]
        );
      if (!result.rows[0]) throw new HttpError(404, "Este comprovante já foi analisado ou não existe.");
      response.json({ submission: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/contacts", authenticate, requirePaidDoula, async (request, response, next) => {
    try {
      const city = requireText(request.query.city ?? "", "cidade", 100);
      const result = await pool.query(
        `SELECT u.id, u.email, p.name, p.city, p.neighborhood
         FROM profiles p
         JOIN users u ON u.id = p.user_id
         WHERE u.role = 'gestante'
           AND p.directory_opt_in = true
           AND p.contact_sharing_opt_in = true
           AND ($1 = '' OR p.city ILIKE '%' || $1 || '%' OR p.neighborhood ILIKE '%' || $1 || '%')
         ORDER BY lower(p.city), lower(p.neighborhood), p.name
         LIMIT 100`,
        [city]
      );
      response.json({ contacts: result.rows });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/doulas", async (request, response, next) => {
    try {
      const city = requireText(request.query.city ?? "", "cidade", 100);
      const service = request.query.service ?? "";
      const sort = request.query.sort ?? "recommended";
      if (service && !services.has(service)) throw new HttpError(400, "Selecione um serviço válido.");
      if (!["recommended", "price-low", "experience"].includes(sort)) throw new HttpError(400, "Ordenação inválida.");
      const result = await pool.query(
        `SELECT u.id, p.name, p.city, p.neighborhood, p.about, p.services,
          p.service_mode, p.experience_years, p.price_cents, p.payment_url,
          EXISTS (
            SELECT 1 FROM billing_submissions active
            WHERE active.doula_id = u.id AND active.status = 'approved' AND active.plan = 'premium' AND active.access_until > now()
          ) AS premium_active
         FROM profiles p JOIN users u ON u.id = p.user_id
         WHERE u.role = 'doula' AND p.published = true
           AND ($1 = '' OR p.city ILIKE '%' || $1 || '%' OR p.neighborhood ILIKE '%' || $1 || '%')
           AND ($2 = '' OR $2 = ANY(p.services))
         ORDER BY
           CASE WHEN $3 = 'recommended' AND EXISTS (
             SELECT 1 FROM billing_submissions active
             WHERE active.doula_id = u.id AND active.status = 'approved' AND active.plan = 'premium' AND active.access_until > now()
           ) THEN 0 ELSE 1 END,
           CASE WHEN $3 = 'price-low' THEN p.price_cents END ASC NULLS LAST,
           CASE WHEN $3 = 'experience' THEN p.experience_years END DESC NULLS LAST,
           p.updated_at DESC, p.name ASC
         LIMIT 60`,
        [city, service, sort]
      );
      response.json({ doulas: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        city: row.city,
        neighborhood: row.neighborhood,
        about: row.about,
        services: row.services,
        serviceMode: row.service_mode,
        experienceYears: row.experience_years,
        priceCents: row.price_cents,
        paymentUrl: row.payment_url,
        isPremium: row.premium_active
      })) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/doulas/:id", async (request, response, next) => {
    if (!/^[0-9a-f-]{36}$/i.test(request.params.id)) return response.status(404).json({ error: "Perfil não encontrado." });
    try {
      const result = await pool.query(
        `SELECT u.id, p.name, p.city, p.neighborhood, p.about, p.services,
          p.service_mode, p.experience_years, p.price_cents, p.payment_url,
          EXISTS (
            SELECT 1 FROM billing_submissions active
            WHERE active.doula_id = u.id AND active.status = 'approved' AND active.plan = 'premium' AND active.access_until > now()
          ) AS premium_active
         FROM profiles p JOIN users u ON u.id = p.user_id
         WHERE u.id = $1 AND u.role = 'doula' AND p.published = true`,
        [request.params.id]
      );
      const row = result.rows[0];
      if (!row) return response.status(404).json({ error: "Perfil não encontrado." });
      response.json({ doula: {
        id: row.id, name: row.name, city: row.city, neighborhood: row.neighborhood,
        about: row.about, services: row.services, serviceMode: row.service_mode,
        experienceYears: row.experience_years, priceCents: row.price_cents, paymentUrl: row.payment_url,
        isPremium: row.premium_active
      } });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/conversations", authenticate, async (request, response, next) => {
    try {
      if (request.user.role === "doula" && !(await hasPaidContactAccess(request.user.id))) {
        return response.status(402).json({ error: "Acesso às conversas bloqueado. Envie o comprovante mensal de R$ 39,90 e aguarde a confirmação do pagamento." });
      }
      const result = await pool.query(
        `SELECT c.id, other.id AS partner_id, p.name AS partner_name, other.role AS partner_role,
                last_message.body AS last_message, last_message.created_at AS last_message_at
         FROM conversations c
         JOIN users other ON other.id = CASE WHEN c.gestante_id = $1 THEN c.doula_id ELSE c.gestante_id END
         LEFT JOIN profiles p ON p.user_id = other.id
         LEFT JOIN LATERAL (
           SELECT body, created_at FROM messages
           WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1
         ) last_message ON true
         WHERE c.gestante_id = $1 OR c.doula_id = $1
         ORDER BY last_message.created_at DESC NULLS LAST, c.created_at DESC`,
        [request.user.id]
      );
      response.json({ conversations: result.rows });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/conversations", authenticate, async (request, response, next) => {
    try {
      if (request.user.role !== "gestante") throw new HttpError(403, "Somente gestantes podem iniciar uma conversa pelo perfil de uma doula.");
      const doulaId = requireText(request.body.doulaId, "doula", 36, { required: true });
      const body = requireText(request.body.message, "mensagem", 2000, { required: true });
      if (!/^[0-9a-f-]{36}$/i.test(doulaId)) throw new HttpError(404, "Perfil não encontrado.");
      const doula = await pool.query(
        `SELECT u.id FROM users u JOIN profiles p ON p.user_id = u.id
         WHERE u.id = $1 AND u.role = 'doula' AND p.published = true`,
        [doulaId]
      );
      if (!doula.rows[0]) throw new HttpError(404, "Perfil não encontrado.");
      const conversationId = randomUUID();
      await pool.query(
        `INSERT INTO conversations (id, gestante_id, doula_id) VALUES ($1, $2, $3)
         ON CONFLICT (gestante_id, doula_id) DO NOTHING`,
        [conversationId, request.user.id, doulaId]
      );
      const conversation = await pool.query("SELECT id FROM conversations WHERE gestante_id = $1 AND doula_id = $2", [request.user.id, doulaId]);
      const id = conversation.rows[0].id;
      await pool.query("INSERT INTO messages (id, conversation_id, sender_id, body) VALUES ($1, $2, $3, $4)", [randomUUID(), id, request.user.id, body]);
      response.status(201).json({ conversationId: id });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/conversations/:id/messages", authenticate, async (request, response, next) => {
    if (!/^[0-9a-f-]{36}$/i.test(request.params.id)) return response.status(404).json({ error: "Conversa não encontrada." });
    try {
      if (request.user.role === "doula") {
        if (!(await hasPaidContactAccess(request.user.id))) throw new HttpError(402, "Acesso às conversas bloqueado. Envie o comprovante mensal de R$ 39,90 e aguarde a confirmação do pagamento.");
      }
      const access = await pool.query(
        "SELECT id FROM conversations WHERE id = $1 AND (gestante_id = $2 OR doula_id = $2)",
        [request.params.id, request.user.id]
      );
      if (!access.rows[0]) throw new HttpError(404, "Conversa não encontrada.");
      const result = await pool.query(
        `SELECT id, sender_id, body, created_at FROM (
           SELECT id, sender_id, body, created_at FROM messages
           WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200
         ) recent ORDER BY created_at ASC, id ASC`,
        [request.params.id]
      );
      response.json({ messages: result.rows });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/conversations/:id/messages", authenticate, async (request, response, next) => {
    if (!/^[0-9a-f-]{36}$/i.test(request.params.id)) return response.status(404).json({ error: "Conversa não encontrada." });
    try {
      if (request.user.role === "doula") {
        if (!(await hasPaidContactAccess(request.user.id))) throw new HttpError(402, "Acesso às conversas bloqueado. Envie o comprovante mensal de R$ 39,90 e aguarde a confirmação do pagamento.");
      }
      const body = requireText(request.body.message, "mensagem", 2000, { required: true });
      const access = await pool.query(
        "SELECT id FROM conversations WHERE id = $1 AND (gestante_id = $2 OR doula_id = $2)",
        [request.params.id, request.user.id]
      );
      if (!access.rows[0]) throw new HttpError(404, "Conversa não encontrada.");
      const result = await pool.query(
        "INSERT INTO messages (id, conversation_id, sender_id, body) VALUES ($1, $2, $3, $4) RETURNING id, sender_id, body, created_at",
        [randomUUID(), request.params.id, request.user.id, body]
      );
      response.status(201).json({ message: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  app.use("/api", (_request, response) => response.status(404).json({ error: "Rota não encontrada." }));
  app.use((error, _request, response, _next) => {
    if (response.headersSent) return;
    if (error instanceof HttpError) return response.status(error.status).json({ error: error.message });
    if (error instanceof multer.MulterError) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      const message = error.code === "LIMIT_FILE_SIZE"
        ? "A imagem do comprovante deve ter até 4 MB."
        : "Envie apenas uma imagem válida do comprovante.";
      return response.status(status).json({ error: message });
    }
    if (error.type === "entity.parse.failed") return response.status(400).json({ error: "O conteúdo enviado não é um JSON válido." });
    console.error("Erro não tratado na API:", error);
    response.status(500).json({ error: "Não foi possível concluir a solicitação. Tente novamente." });
  });
  return app;
}

export async function initializeDatabase(pool, { serialize = false } = {}) {
  const schema = await readFile(path.join(root, "db", "schema.sql"), "utf8");
  if (!serialize) {
    await pool.query(schema);
    await pool.query("DELETE FROM sessions WHERE expires_at <= now()");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(71940261)");
    await client.query(schema);
    await client.query("DELETE FROM sessions WHERE expires_at <= now()");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Configure DATABASE_URL antes de iniciar o serviço.");
  if (process.env.NODE_ENV === "production" && !appOrigin.startsWith("https://")) {
    throw new Error("Configure APP_ORIGIN com o domínio HTTPS de produção.");
  }
  safeCheckoutUrl();
  safeCheckoutUrl("PREMIUM_PAYMENT_CHECKOUT_URL");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
  pool.on("error", (error) => console.error("Erro inesperado no pool do PostgreSQL:", error));
  await initializeDatabase(pool);
  const app = createApp(pool);
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, "0.0.0.0", () => console.log(`colo disponível na porta ${port}`));
  const sessionCleanup = setInterval(() => {
    pool.query("DELETE FROM sessions WHERE expires_at <= now()")
      .catch((error) => console.error("Não foi possível limpar sessões expiradas:", error));
  }, 6 * 60 * 60 * 1000);
  sessionCleanup.unref();
  const shutdown = () => server.close(async () => {
    clearInterval(sessionCleanup);
    await pool.end();
    process.exit(0);
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Não foi possível iniciar o serviço:", error);
    process.exitCode = 1;
  });
}
