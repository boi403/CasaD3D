const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");
require("dotenv").config();

const app = express();

const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5173").split(",").map(s => s.trim());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  }
}));

app.use(express.json());

let db;
try {
  const serviceAccount = require("./serviceAccountKey.json");
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log("Firebase Admin initialized successfully.");
} catch (error) {
  console.warn("WARNING: Firebase Admin failed to initialize. Please check if serviceAccountKey.json is placed in the backend folder.");
  if (process.env.NODE_ENV !== "production") console.warn(error.message);
}

if (!process.env.MP_ACCESS_TOKEN) {
  console.error("FATAL: MP_ACCESS_TOKEN não definido no .env. O servidor não pode processar pagamentos.");
  process.exit(1);
}

const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

// Cria preferência de pagamento
app.post("/api/create-payment", async (req, res) => {
  const { uid, email } = req.body;
  if (!uid || !email || typeof uid !== "string" || typeof email !== "string") {
    return res.status(400).json({ error: "Parâmetros uid e email são obrigatórios" });
  }

  try {
    const preference = new Preference(mpClient);
    const response = await preference.create({
      body: {
        items: [{ title: "Acesso Completo - Camada 3D", quantity: 1, unit_price: 99.90, currency_id: "BRL" }],
        payer: { email },
        external_reference: uid,
        back_urls: {
          success: allowedOrigins[0],
          failure: allowedOrigins[0],
          pending: allowedOrigins[0]
        },
        auto_return: "approved"
      }
    });
    res.json({ id: response.id, checkoutUrl: response.init_point });
  } catch (error) {
    if (process.env.NODE_ENV !== "production") console.error("Erro ao criar preferência do Mercado Pago:", error);
    res.status(500).json({ error: "Não foi possível gerar o link de pagamento" });
  }
});

// Webhook do MercadoPago com verificação de assinatura
app.post("/api/webhook/mp", async (req, res) => {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (secret) {
    const xSignature = req.headers["x-signature"];
    const xRequestId = req.headers["x-request-id"];
    const dataId = req.query["data.id"] || req.body?.data?.id;

    if (!xSignature) return res.sendStatus(401);

    const parts = xSignature.split(",");
    const ts = parts.find(p => p.startsWith("ts="))?.split("=")[1];
    const v1 = parts.find(p => p.startsWith("v1="))?.split("=")[1];
    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const expected = crypto.createHmac("sha256", secret).update(manifest).digest("hex");

    if (!crypto.timingSafeEqual(Buffer.from(v1 || "", "hex"), Buffer.from(expected, "hex"))) {
      return res.sendStatus(401);
    }
  }

  const { type, data } = req.body;
  const paymentId = data?.id || req.query.id;

  if ((type === "payment" || req.query.topic === "payment") && paymentId) {
    try {
      const payment = await new Payment(mpClient).get({ id: paymentId });

      if (payment.status === "approved") {
        const uid = payment.external_reference;
        if (uid && db) {
          await db.collection("users").doc(uid).set({
            active: true,
            paid: true,
            paymentId: String(paymentId),
            paidAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          if (process.env.NODE_ENV !== "production") console.log(`Usuário ${uid} ativado após pagamento ${paymentId}`);
        }
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "production") console.error("Erro ao processar webhook:", error);
      return res.status(500).send("Erro ao processar o webhook");
    }
  }

  res.sendStatus(200);
});

app.get("/health", (req, res) => {
  res.json({ status: "OK", firebaseAdmin: !!db });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
