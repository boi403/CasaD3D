const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

let db;
try {
  const serviceAccount = require("./serviceAccountKey.json");
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
  console.log("Firebase Admin initialized successfully.");
} catch (error) {
  console.warn("WARNING: Firebase Admin failed to initialize. Please check if serviceAccountKey.json is placed in the backend folder.");
  console.warn(error.message);
}

// Configuração do Mercado Pago
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || "TEST-509930777521020-062109-0dcf8b46a7be74a621743a12ef6484e5-104902745" // valor padrão para desenvolvimento
});

// Endpoint para gerar a preferência de pagamento (checkout link)
app.post("/api/create-payment", async (req, res) => {
  const { uid, email } = req.body;
  if (!uid || !email) {
    return res.status(400).json({ error: "Parâmetros uid e email são obrigatórios" });
  }

  try {
    const preference = await new Preference(mpClient).create({
      body: {
        items: [
          {
            title: "Acesso Completo - Camada 3D",
            quantity: 1,
            unit_price: 99.90, // R$ 99,90 pago uma única vez
            currency_id: "BRL"
          }
        ],
        payer: {
          email: email
        },
        external_reference: uid, // O ID do usuário no Firebase
        back_urls: {
          success: process.env.FRONTEND_URL || "http://localhost:5173",
          failure: process.env.FRONTEND_URL || "http://localhost:5173",
          pending: process.env.FRONTEND_URL || "http://localhost:5173"
        },
        auto_return: "approved"
      }
    });

    res.json({ checkoutUrl: preference.init_point });
  } catch (error) {
    console.error("Erro ao criar preferência do Mercado Pago:", error);
    res.status(500).json({ error: "Não foi possível gerar o link de pagamento" });
  }
});

// Endpoint do Webhook do Mercado Pago para receber notificações de pagamento
app.post("/api/webhook/mp", async (req, res) => {
  const { action, type, data } = req.body;
  console.log("Notificação recebida:", { action, type, data });

  if (type === "payment" || req.query.topic === "payment") {
    const paymentId = data?.id || req.query.id;
    if (!paymentId) {
      return res.sendStatus(400);
    }

    try {
      const payment = await new Payment(mpClient).get({ id: paymentId });
      console.log("Detalhes do pagamento recebido:", {
        id: payment.id,
        status: payment.status,
        external_reference: payment.external_reference
      });

      if (payment.status === "approved") {
        const uid = payment.external_reference;
        if (uid && db) {
          // Atualiza o documento do usuário no Firestore para liberar acesso
          const userRef = db.collection("users").doc(uid);
          await userRef.set({
            active: true,
            paid: true,
            paymentId: paymentId,
            paidAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          console.log(`Usuário ${uid} ativado com sucesso após o pagamento ${paymentId}`);
        } else {
          console.warn(`Pagamento aprovado, mas o UID do usuário está ausente ou o Firestore não inicializou. UID: ${uid}`);
        }
      }
    } catch (error) {
      console.error("Erro ao processar o webhook do Mercado Pago:", error);
      return res.status(500).send("Erro ao processar o webhook");
    }
  }

  // Sempre retornar 200 para o Mercado Pago não reenviar a notificação
  res.sendStatus(200);
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK", firebaseAdmin: !!db });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
