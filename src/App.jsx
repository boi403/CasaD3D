import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  LayoutDashboard, Boxes, Package, Settings as SettingsIcon, Plus, Pencil,
  Trash2, Zap, Clock, TrendingUp, AlertTriangle, X, Layers, Wallet,
  ShoppingBag, Tag, Database, Download, Upload, Printer, CircleDollarSign,
  Play, CheckCircle2, XCircle, Wrench, Trophy, Activity, ShoppingCart, LogOut,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from "recharts";
import { auth, db } from "./firebase";
import { 
  onAuthStateChanged, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut,
  GoogleAuthProvider,
  signInWithPopup
} from "firebase/auth";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { initMercadoPago, Wallet as MpWallet } from "@mercadopago/sdk-react";

// Inicializa o Mercado Pago
initMercadoPago(import.meta.env.VITE_MERCADOPAGO_PUBLIC_KEY || "SUA_PUBLIC_KEY_AQUI");

// Fallback para window.storage caso esteja rodando num navegador comum
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    get: async (key) => {
      try {
        const value = localStorage.getItem(key);
        return value ? { value } : null;
      } catch (e) {
        return null;
      }
    },
    set: async (key, val) => {
      try {
        localStorage.setItem(key, val);
      } catch (e) {
        // Silently catch write errors
      }
    }
  };
}

// === Constantes ===
const STORAGE_KEY = "camada-print3d-v1";

const DEFAULT_CONFIG = {
  energiaKwh: 0.92,      // R$/kWh
  potenciaW: 150,        // potência média da impressora (W)
  maoDeObraHora: 0,      // R$/h de operação/acabamento
  custoFalhaPct: 5,      // % de buffer para falhas/desperdício
  margemPadrao: 120,     // % de margem sobre o custo
  metodoPrecificacao: "markup_custo", // "markup_custo" | "markup_divisor"
  despesasFixasMensais: 19400,
  faturamentoMensal: 300000,
  impostosPct: 9.25,
  plataformas: [
    { id: "ml", nome: "Mercado Livre", taxa: 14 },
    { id: "shopee", nome: "Shopee", taxa: 20 },
  ],
};

const TIPOS = ["PLA", "PLA Seda", "ABS", "PETG", "TPU", "Nylon", "Resina", "Outro"];
const MARCAS = ["Bambu Lab", "Creality", "Prusa", "Elegoo", "Anycubic", "Sovol", "Voron", "Outra"];
const COLORS = ["#F25C05", "#14181F", "#64748b", "#0ea5e9", "#10b981", "#f59e0b", "#a855f7", "#e11d48"];

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
:root{
  --bg:#F3F4F6; --surface:#FFFFFF; --ink:#14181F; --muted:#6B7280;
  --line:#E5E7EB; --accent:#F25C05; --accent-soft:#FFF1E8; --accent-deep:#B8430A;
}
.ui{ font-family:'Space Grotesk',ui-sans-serif,system-ui,-apple-system,sans-serif; }
.font-display{ font-family:'Space Grotesk',ui-sans-serif,system-ui,sans-serif; }
.font-data{ font-family:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace; font-variant-numeric:tabular-nums; }
.bed-grid{
  background-color:var(--bg);
  background-image:
    linear-gradient(to right, rgba(20,24,31,.045) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(20,24,31,.045) 1px, transparent 1px);
  background-size:22px 22px;
}
.layer-edge{
  height:4px;
  background-image:repeating-linear-gradient(90deg, var(--accent) 0 11px, rgba(242,92,5,.28) 11px 17px);
}
.tab-btn{ position:relative; transition:color .15s ease; }
.tab-btn:hover{ color:var(--ink); }
input:focus-visible, select:focus-visible, button:focus-visible{ outline:2px solid var(--accent); outline-offset:2px; }
::-webkit-scrollbar{ width:10px; height:10px; }
::-webkit-scrollbar-thumb{ background:#cbd1d9; border-radius:8px; }
@keyframes pulse{ 0%,100%{ opacity:1 } 50%{ opacity:.35 } }
.pulse-dot{ animation:pulse 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce){ *{ transition:none !important; animation:none !important; } }
`;

// === Helpers ===
const brl = (v) => (isFinite(v) ? v : 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = (v, d = 0) => (isFinite(v) ? v : 0).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });

function parseNum(s) {
  if (s === "" || s == null) return 0;
  if (typeof s === "number") return isFinite(s) ? s : 0;
  let t = String(s).trim().replace(/\s/g, "");
  if (t.includes(",") && t.includes(".")) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(",", ".");
  const n = parseFloat(t);
  return isFinite(n) ? n : 0;
}
const uid = () => crypto.randomUUID();
const shorten = (s, n = 14) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const todayISO = () => new Date().toISOString().slice(0, 10);

function horasFmt(h) {
  const total = Math.round((h || 0) * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  if (hh && mm) return `${hh}h ${mm}min`;
  if (hh) return `${hh}h`;
  return `${mm}min`;
}

// === Motor de cálculo ===
function custoPorGrama(fil) {
  if (!fil || !fil.pesoCompradoG) return 0;
  return fil.custoCompra / fil.pesoCompradoG;
}
function taxaPlataforma(nome, config) {
  const p = (config.plataformas || []).find((x) => x.nome === nome);
  return p ? p.taxa || 0 : 0;
}
function calcProduto(p, fil, config) {
  const cpg = custoPorGrama(fil);
  const custoFil = (p.gramasUsadas || 0) * cpg;
  const custoEnergia = (p.tempoHoras || 0) * ((config.potenciaW || 0) / 1000) * (config.energiaKwh || 0);
  const custoMao = (p.tempoHoras || 0) * (config.maoDeObraHora || 0);
  const extras = p.custosExtras || 0;
  const custoArmazenagem = p.custoArmazenagem || 0;
  const subtotal = custoFil + custoEnergia + custoMao + extras;
  const buffer = subtotal * ((config.custoFalhaPct || 0) / 100);
  const custoTotal = subtotal + buffer;
  const margem = p.margem != null && p.margem !== "" ? p.margem : config.margemPadrao;
  const taxa = taxaPlataforma(p.plataforma, config);

  if (config.metodoPrecificacao === "markup_divisor") {
    const despesasFixasPct = (config.despesasFixasMensais || 0) / (config.faturamentoMensal || 1) * 100;
    const impostosPct = config.impostosPct || 0;
    const divisor = 1 - (taxa + impostosPct + despesasFixasPct + margem) / 100;
    const divisorSeguro = Math.max(0.01, divisor);
    const precoSugerido = (custoTotal + custoArmazenagem) / divisorSeguro;
    const preco = p.precoVenda && p.precoVenda > 0 ? p.precoVenda : precoSugerido;
    const receitaLiquida = preco * (1 - (taxa + impostosPct) / 100);
    const lucro = preco * (1 - (taxa + impostosPct + despesasFixasPct) / 100) - (custoTotal + custoArmazenagem);
    const margemReal = (custoTotal + custoArmazenagem) > 0 ? (lucro / (custoTotal + custoArmazenagem)) * 100 : 0;
    const custoTotalProduto = preco - lucro;
    return { cpg, custoFil, custoEnergia, custoMao, extras, buffer, custoTotal, margem, taxa, precoSugerido, preco, receitaLiquida, lucro, margemReal, custoArmazenagem, custoTotalProduto };
  } else {
    const fator = taxa < 100 ? 1 - taxa / 100 : 1;
    const precoSugerido = ((custoTotal + custoArmazenagem) * (1 + margem / 100)) / fator;
    const preco = p.precoVenda && p.precoVenda > 0 ? p.precoVenda : precoSugerido;
    const receitaLiquida = preco * fator;
    const lucro = receitaLiquida - (custoTotal + custoArmazenagem);
    const margemReal = (custoTotal + custoArmazenagem) > 0 ? (lucro / (custoTotal + custoArmazenagem)) * 100 : 0;
    const custoTotalProduto = custoTotal + custoArmazenagem;
    return { cpg, custoFil, custoEnergia, custoMao, extras, buffer, custoTotal, margem, taxa, precoSugerido, preco, receitaLiquida, lucro, margemReal, custoArmazenagem, custoTotalProduto };
  }
}
function calcVenda(sale, product, fil, config) {
  const fee = taxaPlataforma(sale.plataforma, config);
  const receitaBruta = (sale.precoUnit || 0) * (sale.quantidade || 0);

  if (config.metodoPrecificacao === "markup_divisor") {
    const despesasFixasPct = (config.despesasFixasMensais || 0) / (config.faturamentoMensal || 1) * 100;
    const impostosPct = config.impostosPct || 0;
    const receitaLiq = receitaBruta * (1 - (fee + impostosPct) / 100);
    const c = product ? calcProduto(product, fil, config) : { custoTotal: 0, custoArmazenagem: 0 };
    const custoProducao = (c.custoTotal + (product?.custoArmazenagem || 0)) * (sale.quantidade || 0);
    const custoFixoRateado = receitaBruta * (despesasFixasPct / 100);
    const lucro = receitaLiq - custoProducao - custoFixoRateado;
    return { fee, receitaBruta, receitaLiq, custo: custoProducao + custoFixoRateado, lucro };
  } else {
    const receitaLiq = receitaBruta * (1 - fee / 100);
    const c = product ? calcProduto(product, fil, config) : { custoTotal: 0, custoArmazenagem: 0 };
    const custo = (c.custoTotal + (product?.custoArmazenagem || 0)) * (sale.quantidade || 0);
    const lucro = receitaLiq - custo;
    return { fee, receitaBruta, receitaLiq, custo, lucro };
  }
}

// === UI primitivos ===
function Card({ children, className = "" }) {
  return <div className={`bg-white rounded-xl shadow-sm ${className}`} style={{ border: "1px solid var(--line)" }}>{children}</div>;
}
function PrimaryBtn({ children, onClick, className = "" }) {
  return (
    <button onClick={onClick} className={`inline-flex items-center gap-2 text-sm font-semibold text-white px-4 py-2 rounded-lg hover:opacity-90 transition ${className}`} style={{ background: "var(--accent)" }}>
      {children}
    </button>
  );
}
function GhostBtn({ children, onClick, className = "" }) {
  return (
    <button onClick={onClick} className={`inline-flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg bg-white hover:bg-slate-50 transition ${className}`} style={{ border: "1px solid var(--line)", color: "var(--ink)" }}>
      {children}
    </button>
  );
}
function Field({ label, value, onChange, placeholder, suffix, help, type = "text", options, color }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-500 mb-1">{label}</span>
      {options ? (
        <select value={value} onChange={(e) => onChange(e.target.value)} className="w-full bg-white px-3 py-2 text-sm rounded-lg outline-none ui" style={{ border: "1px solid var(--line)", color: "var(--ink)" }}>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : color ? (
        <div className="flex items-center gap-2">
          <input type="color" value={value || "#333333"} onChange={(e) => onChange(e.target.value)} className="h-9 w-12 rounded-lg cursor-pointer bg-white" style={{ border: "1px solid var(--line)" }} />
          <span className="text-xs font-data text-slate-400">{value}</span>
        </div>
      ) : (
        <div className="flex items-center rounded-lg bg-white overflow-hidden" style={{ border: "1px solid var(--line)" }}>
          <input value={value} placeholder={placeholder} type={type === "date" ? "date" : undefined} inputMode={type === "num" ? "decimal" : undefined} onChange={(e) => onChange(e.target.value)} className="w-full bg-transparent px-3 py-2 text-sm font-data outline-none" />
          {suffix && <span className="px-3 text-xs text-slate-400 font-data shrink-0">{suffix}</span>}
        </div>
      )}
      {help && <span className="block text-xs text-slate-400 mt-1">{help}</span>}
    </label>
  );
}
function Modal({ title, subtitle, onClose, children, footer, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0" style={{ background: "rgba(10,12,16,.5)", backdropFilter: "blur(2px)" }} onClick={onClose} />
      <div className="relative w-full bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col" style={{ border: "1px solid var(--line)", maxHeight: "92vh", maxWidth: wide ? "56rem" : "32rem" }}>
        <div className="flex items-start justify-between px-5 py-4" style={{ borderBottom: "1px solid var(--line)" }}>
          <div>
            <h3 className="font-display text-lg font-semibold" style={{ color: "var(--ink)" }}>{title}</h3>
            {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="p-2 -mr-2 rounded-lg hover:bg-slate-100 transition"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="px-5 py-4 flex justify-end gap-2" style={{ borderTop: "1px solid var(--line)" }}>{footer}</div>}
      </div>
    </div>
  );
}
function EmptyState({ icon: Icon, title, desc, children }) {
  return (
    <Card className="p-10 text-center">
      <div className="mx-auto w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: "var(--accent-soft)" }}>
        <Icon size={22} style={{ color: "var(--accent)" }} />
      </div>
      <h3 className="font-display text-lg font-semibold mt-4" style={{ color: "var(--ink)" }}>{title}</h3>
      <p className="text-sm text-slate-500 mt-1 max-w-sm mx-auto">{desc}</p>
      <div className="mt-5 flex flex-wrap gap-2 justify-center">{children}</div>
    </Card>
  );
}
function Chip({ children, color }) {
  return <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: color || "#f1f5f9", color: "#334155" }}>{children}</span>;
}
function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className="font-data" style={{ color: "var(--ink)" }}>{value}</span>
    </div>
  );
}
function Kpi({ icon: Icon, label, value, sub, accent }) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center gap-2 text-slate-500">
        <Icon size={15} />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="mt-2 font-display text-2xl sm:text-3xl font-bold leading-tight" style={accent ? { color: "var(--accent)" } : { color: "var(--ink)" }}>{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Analytics de vendas (compartilhado)                                */
/* ------------------------------------------------------------------ */
function useVendaStats(sales, products, filaments, config, periodo) {
  return useMemo(() => {
    const now = new Date();
    const ym = now.toISOString().slice(0, 7);
    const list = periodo === "mes" ? sales.filter((s) => (s.data || "").slice(0, 7) === ym) : sales;
    let fat = 0, lucro = 0, itens = 0;
    const porPlat = {};
    const porProduto = {};
    const platProduto = {}; // plataforma -> {produto: qtd}
    list.forEach((s) => {
      const product = products.find((p) => p.id === s.produtoId);
      const fil = product ? filaments.find((f) => f.id === product.filamentoId) : null;
      const c = calcVenda(s, product, fil, config);
      fat += c.receitaBruta; lucro += c.lucro; itens += s.quantidade || 0;
      porPlat[s.plataforma] = porPlat[s.plataforma] || { fat: 0, qtd: 0 };
      porPlat[s.plataforma].fat += c.receitaBruta;
      porPlat[s.plataforma].qtd += s.quantidade || 0;
      porProduto[s.produtoNome] = (porProduto[s.produtoNome] || 0) + (s.quantidade || 0);
      platProduto[s.plataforma] = platProduto[s.plataforma] || {};
      platProduto[s.plataforma][s.produtoNome] = (platProduto[s.plataforma][s.produtoNome] || 0) + (s.quantidade || 0);
    });
    const pedidos = list.length;
    const topProdutos = Object.entries(porProduto).map(([nome, qtd]) => ({ nome, qtd })).sort((a, b) => b.qtd - a.qtd);
    const platBars = Object.entries(porPlat).map(([nome, v]) => ({ nome, Faturamento: +v.fat.toFixed(2), qtd: v.qtd }));
    const campeao = topProdutos[0] || null;
    const plataformaTop = platBars.slice().sort((a, b) => b.Faturamento - a.Faturamento)[0] || null;
    const maisPorPlataforma = Object.entries(platProduto).map(([plat, prods]) => {
      const top = Object.entries(prods).sort((a, b) => b[1] - a[1])[0];
      return { plataforma: plat, produto: top ? top[0] : "—", qtd: top ? top[1] : 0 };
    });
    return { fat, lucro, itens, pedidos, ticket: pedidos ? fat / pedidos : 0, topProdutos, platBars, campeao, plataformaTop, maisPorPlataforma, count: list.length };
  }, [sales, products, filaments, config, periodo]);
}

// === Painel ===
function Painel({ filaments, products, printers, sales, config, now, go }) {
  const valorEstoque = filaments.reduce((s, f) => s + (f.pesoEstoqueG || 0) * custoPorGrama(f), 0);
  const baixos = filaments.filter((f) => (f.pesoEstoqueG || 0) <= (f.alertaG || 0));
  const mes = useVendaStats(sales, products, filaments, config, "mes");
  const total = useVendaStats(sales, products, filaments, config, "tudo");
  const imprimindo = printers.filter((p) => p.status === "imprimindo");

  const barData = products.slice(0, 8).map((p) => {
    const fil = filaments.find((f) => f.id === p.filamentoId);
    const c = calcProduto(p, fil, config);
    return { nome: shorten(p.nome, 12), Custo: +c.custoTotal.toFixed(2), Preço: +c.preco.toFixed(2) };
  });
  const porTipo = {};
  filaments.forEach((f) => { porTipo[f.tipo] = (porTipo[f.tipo] || 0) + (f.pesoEstoqueG || 0); });
  const pieData = Object.entries(porTipo).map(([name, value]) => ({ name, value: +value.toFixed(0) }));

  const vazio = !filaments.length && !products.length && !printers.length && !sales.length;
  if (vazio) {
    return (
      <EmptyState icon={Layers} title="Vamos montar sua operação" desc="Cadastre seus filamentos e impressoras, crie os produtos e registre as vendas. O painel cuida dos números.">
        <PrimaryBtn onClick={() => go("filamentos")}><Plus size={16} /> Cadastrar filamento</PrimaryBtn>
        <GhostBtn onClick={() => go("config")}><Database size={16} /> Carregar exemplo</GhostBtn>
      </EmptyState>
    );
  }

  return (
    <div className="space-y-5">
      {printers.length > 0 && (
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Activity size={15} style={{ color: "var(--accent)" }} />
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Impressoras agora</span>
            <span className="text-xs text-slate-400 ml-auto">{imprimindo.length} imprimindo · {printers.length - imprimindo.length} ociosa{printers.length - imprimindo.length === 1 ? "" : "s"}</span>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {printers.map((pr) => <PrinterMini key={pr.id} pr={pr} now={now} onClick={() => go("impressoras")} />)}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={CircleDollarSign} label="Faturamento (mês)" value={brl(mes.fat)} sub={`${mes.pedidos} pedido${mes.pedidos === 1 ? "" : "s"}`} accent />
        <Kpi icon={TrendingUp} label="Lucro (mês)" value={brl(mes.lucro)} sub="após taxas e custo" />
        <Kpi icon={ShoppingCart} label="Itens vendidos (mês)" value={num(mes.itens)} sub={`ticket ${brl(mes.ticket)}`} />
        <Kpi icon={Wallet} label="Valor em estoque" value={brl(valorEstoque)} sub="filamento a custo" />
      </div>

      {total.count > 0 && (
        <div className="grid sm:grid-cols-2 gap-3">
          <Card className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: "var(--accent-soft)" }}><Trophy size={18} style={{ color: "var(--accent)" }} /></div>
            <div>
              <div className="text-xs text-slate-400">Produto que mais sai (total)</div>
              <div className="font-display font-semibold" style={{ color: "var(--ink)" }}>{total.campeao ? `${total.campeao.nome}` : "—"}</div>
              {total.campeao && <div className="text-xs text-slate-400">{num(total.campeao.qtd)} unidades</div>}
            </div>
          </Card>
          <Card className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: "#eef2ff" }}><ShoppingBag size={18} style={{ color: "#4f46e5" }} /></div>
            <div>
              <div className="text-xs text-slate-400">Plataforma que mais fatura (total)</div>
              <div className="font-display font-semibold" style={{ color: "var(--ink)" }}>{total.plataformaTop ? total.plataformaTop.nome : "—"}</div>
              {total.plataformaTop && <div className="text-xs text-slate-400">{brl(total.plataformaTop.Faturamento)}</div>}
            </div>
          </Card>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <h3 className="font-display font-semibold mb-1" style={{ color: "var(--ink)" }}>Custo × Preço de venda</h3>
          <p className="text-xs text-slate-400 mb-3">por produto {products.length > 8 ? "(8 principais)" : ""}</p>
          {barData.length ? (
            <div style={{ width: "100%", height: 260 }}>
              <ResponsiveContainer>
                <BarChart data={barData} margin={{ top: 4, right: 8, left: -8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
                  <XAxis dataKey="nome" tick={{ fontSize: 11, fill: "#94a3b8" }} interval={0} />
                  <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} width={42} />
                  <Tooltip formatter={(v) => brl(v)} contentStyle={{ borderRadius: 10, border: "1px solid var(--line)", fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Custo" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Preço" fill="#F25C05" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <p className="text-sm text-slate-400 py-12 text-center">Cadastre um produto para ver o comparativo.</p>}
        </Card>

        <Card className="p-5">
          <h3 className="font-display font-semibold mb-1" style={{ color: "var(--ink)" }}>Estoque por tipo de filamento</h3>
          <p className="text-xs text-slate-400 mb-3">em gramas</p>
          {pieData.length ? (
            <div style={{ width: "100%", height: 260 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
                    {pieData.map((e, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v) => `${num(v)} g`} contentStyle={{ borderRadius: 10, border: "1px solid var(--line)", fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : <p className="text-sm text-slate-400 py-12 text-center">Sem filamentos cadastrados.</p>}
        </Card>
      </div>

      {baixos.length > 0 && (
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={16} style={{ color: "var(--accent)" }} />
            <h3 className="font-display font-semibold" style={{ color: "var(--ink)" }}>Filamentos com estoque baixo</h3>
          </div>
          <div className="space-y-2">
            {baixos.map((f) => (
              <div key={f.id} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full" style={{ background: f.cor }} />
                  <span style={{ color: "var(--ink)" }}>{f.nome}</span><Chip>{f.tipo}</Chip>
                </span>
                <span className="font-data text-rose-600">{num(f.pesoEstoqueG)} g restantes</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function jobProgress(pr, now) {
  if (!pr.job) return null;
  const elapsedMin = (now - pr.job.startTime) / 60000;
  const estim = pr.job.estimMin || 0;
  const pct = estim > 0 ? Math.max(0, Math.min(100, (elapsedMin / estim) * 100)) : 0;
  const restanteMin = Math.max(0, estim - elapsedMin);
  return { elapsedMin, estim, pct, restanteMin, done: estim > 0 && elapsedMin >= estim };
}

function PrinterMini({ pr, now, onClick }) {
  const p = jobProgress(pr, now);
  return (
    <button onClick={onClick} className="text-left rounded-lg p-3 hover:bg-slate-50 transition w-full" style={{ border: "1px solid var(--line)" }}>
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm truncate" style={{ color: "var(--ink)" }}>{pr.apelido}</span>
        <StatusDot status={pr.status} />
      </div>
      {pr.status === "imprimindo" && p ? (
        <>
          <div className="text-xs text-slate-500 mt-1 truncate">{pr.job.produtoNome}</div>
          <div className="h-1.5 rounded-full overflow-hidden mt-2" style={{ background: "#eef0f3" }}>
            <div className="h-full rounded-full" style={{ width: `${p.pct}%`, background: "var(--accent)" }} />
          </div>
          <div className="text-xs font-data text-slate-400 mt-1">{num(p.pct)}% · {p.done ? "tempo atingido" : `${horasFmt(p.restanteMin / 60)} restantes`}</div>
        </>
      ) : (
        <div className="text-xs text-slate-400 mt-1">{pr.marca} {pr.modelo}</div>
      )}
    </button>
  );
}

function StatusDot({ status }) {
  const map = {
    imprimindo: { c: "#F25C05", t: "imprimindo", pulse: true },
    ociosa: { c: "#94a3b8", t: "ociosa", pulse: false },
    manutencao: { c: "#0ea5e9", t: "manutenção", pulse: false },
  };
  const s = map[status] || map.ociosa;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: s.c }}>
      <span className={`w-2 h-2 rounded-full ${s.pulse ? "pulse-dot" : ""}`} style={{ background: s.c }} /> {s.t}
    </span>
  );
}

// === Impressoras ===
function Impressoras({ printers, products, config, now, onAdd, onEdit, onDelete, onStartJob, onFinishJob, onCancelJob, onSetStatus }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-xl font-bold" style={{ color: "var(--ink)" }}>Impressoras</h2>
          <p className="text-sm text-slate-500">{printers.length} cadastrada{printers.length === 1 ? "" : "s"}</p>
        </div>
        <PrimaryBtn onClick={onAdd}><Plus size={16} /> Nova impressora</PrimaryBtn>
      </div>

      {printers.length === 0 ? (
        <EmptyState icon={Printer} title="Cadastre suas impressoras" desc="Registre marca e modelo (ex.: Bambu Lab A1). Inicie uma impressão e acompanhe o progresso e o tempo restante aqui.">
          <PrimaryBtn onClick={onAdd}><Plus size={16} /> Cadastrar impressora</PrimaryBtn>
        </EmptyState>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {printers.map((pr) => {
            const p = jobProgress(pr, now);
            return (
              <Card key={pr.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: "#f1f5f9" }}><Printer size={18} className="text-slate-600" /></div>
                    <div className="min-w-0">
                      <div className="font-semibold truncate" style={{ color: "var(--ink)" }}>{pr.apelido}</div>
                      <div className="text-xs text-slate-400 truncate">{pr.marca} {pr.modelo}</div>
                    </div>
                  </div>
                  <StatusDot status={pr.status} />
                </div>

                {pr.status === "imprimindo" && p ? (
                  <div className="mt-3 rounded-lg p-3" style={{ background: "var(--accent-soft)" }}>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium truncate" style={{ color: "var(--accent-deep)" }}>{pr.job.produtoNome}</span>
                      <span className="text-xs font-data" style={{ color: "var(--accent-deep)" }}>{num(p.pct)}%</span>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden mt-2" style={{ background: "rgba(0,0,0,.08)" }}>
                      <div className="h-full rounded-full" style={{ width: `${p.pct}%`, background: "var(--accent)" }} />
                    </div>
                    <div className="flex items-center justify-between text-xs font-data mt-1.5" style={{ color: "var(--accent-deep)" }}>
                      <span>{horasFmt(p.elapsedMin / 60)} rodados</span>
                      <span>{p.done ? "tempo estimado atingido" : `faltam ${horasFmt(p.restanteMin / 60)}`}</span>
                    </div>
                    <div className="flex gap-2 mt-3">
                      <button onClick={() => onFinishJob(pr)} className="flex-1 inline-flex items-center justify-center gap-1 text-xs font-semibold py-2 rounded-lg text-white" style={{ background: "#059669" }}><CheckCircle2 size={14} /> Concluir</button>
                      <button onClick={() => onCancelJob(pr)} className="inline-flex items-center justify-center gap-1 text-xs font-medium py-2 px-3 rounded-lg text-slate-600 bg-white" style={{ border: "1px solid var(--line)" }}><XCircle size={14} /> Cancelar</button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button onClick={() => onStartJob(pr)} className="inline-flex items-center gap-1 text-xs font-semibold py-2 px-3 rounded-lg text-white" disabled={products.length === 0} style={{ background: "var(--accent)" }}><Play size={14} /> Iniciar impressão</button>
                    {pr.status !== "manutencao" ? (
                      <button onClick={() => onSetStatus(pr, "manutencao")} className="inline-flex items-center gap-1 text-xs font-medium py-2 px-3 rounded-lg text-slate-600 bg-white" style={{ border: "1px solid var(--line)" }}><Wrench size={14} /> Manutenção</button>
                    ) : (
                      <button onClick={() => onSetStatus(pr, "ociosa")} className="inline-flex items-center gap-1 text-xs font-medium py-2 px-3 rounded-lg text-slate-600 bg-white" style={{ border: "1px solid var(--line)" }}>Marcar ociosa</button>
                    )}
                  </div>
                )}
                {products.length === 0 && pr.status !== "imprimindo" && <p className="text-xs text-slate-400 mt-2">Cadastre um produto para iniciar impressões.</p>}

                <div className="mt-3 flex items-center justify-between pt-3" style={{ borderTop: "1px solid var(--line)" }}>
                  <span className="text-xs text-slate-400 font-data">{horasFmt((pr.totalMin || 0) / 60)} impressas</span>
                  <span className="flex gap-1">
                    <button onClick={() => onEdit(pr)} className="inline-flex items-center gap-1 text-xs font-medium py-1.5 px-2 rounded-lg hover:bg-slate-100 transition text-slate-600"><Pencil size={13} /> Editar</button>
                    <button onClick={() => onDelete(pr)} className="inline-flex items-center gap-1 text-xs font-medium py-1.5 px-2 rounded-lg hover:bg-rose-50 transition text-rose-600"><Trash2 size={13} /></button>
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PrinterForm({ initial, onSave, onClose }) {
  const [p, setP] = useState(initial || { apelido: "", marca: "Bambu Lab", modelo: "", status: "ociosa" });
  const set = (k) => (v) => setP((s) => ({ ...s, [k]: v }));
  const save = () => {
    if (!p.apelido.trim()) return;
    onSave({ id: p.id || uid(), apelido: p.apelido.trim(), marca: p.marca, modelo: p.modelo.trim(), status: p.status || "ociosa", job: p.job || null, totalMin: p.totalMin || 0 });
  };
  return (
    <Modal title={initial ? "Editar impressora" : "Nova impressora"} subtitle="Identifique a máquina" onClose={onClose}
      footer={<><GhostBtn onClick={onClose}>Cancelar</GhostBtn><PrimaryBtn onClick={save}>Salvar</PrimaryBtn></>}>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2"><Field label="Apelido" value={p.apelido} onChange={set("apelido")} placeholder="Ex.: Bambu 1" /></div>
        <Field label="Marca" value={p.marca} onChange={set("marca")} options={MARCAS} />
        <Field label="Modelo" value={p.modelo} onChange={set("modelo")} placeholder="Ex.: A1, X1 Carbon, Ender 3" />
      </div>
    </Modal>
  );
}

function JobForm({ printer, products, filaments, config, onStart, onClose }) {
  const [produtoId, setProdutoId] = useState(products[0] ? products[0].id : "");
  const [qtd, setQtd] = useState("1");
  const [horas, setHoras] = useState("");
  const [minutos, setMinutos] = useState("");
  const prod = products.find((p) => p.id === produtoId);
  const fil = prod ? filaments.find((f) => f.id === prod.filamentoId) : null;
  const perUnitMin = prod ? (prod.tempoHoras || 0) * 60 : 0;
  const sugeridoMin = perUnitMin * (parseNum(qtd) || 1);
  const estimMin = (parseNum(horas) || parseNum(minutos)) ? parseNum(horas) * 60 + parseNum(minutos) : sugeridoMin;
  const start = () => {
    if (!prod) return;
    onStart(printer.id, { produtoId: prod.id, produtoNome: prod.nome, startTime: Date.now(), estimMin, qtd: parseNum(qtd) || 1 });
  };
  const opts = products.map((p) => p.nome);
  const byName = (n) => products.find((p) => p.nome === n);
  return (
    <Modal title={`Iniciar impressão · ${printer.apelido}`} subtitle="O tempo conta a partir de agora" onClose={onClose}
      footer={<><GhostBtn onClick={onClose}>Cancelar</GhostBtn><PrimaryBtn onClick={start}><Play size={15} /> Iniciar</PrimaryBtn></>}>
      <div className="space-y-4">
        <Field label="Produto" value={prod ? prod.nome : ""} onChange={(n) => setProdutoId(byName(n)?.id || "")} options={opts} />
        <Field label="Quantidade" value={qtd} onChange={setQtd} suffix="un" type="num" />
        <div>
          <span className="block text-xs font-medium text-slate-500 mb-1">Tempo estimado (opcional)</span>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center rounded-lg bg-white overflow-hidden" style={{ border: "1px solid var(--line)" }}>
              <input value={horas} inputMode="decimal" onChange={(e) => setHoras(e.target.value)} placeholder="0" className="w-full bg-transparent px-3 py-2 text-sm font-data outline-none" />
              <span className="px-3 text-xs text-slate-400 font-data">h</span>
            </div>
            <div className="flex items-center rounded-lg bg-white overflow-hidden" style={{ border: "1px solid var(--line)" }}>
              <input value={minutos} inputMode="decimal" onChange={(e) => setMinutos(e.target.value)} placeholder="0" className="w-full bg-transparent px-3 py-2 text-sm font-data outline-none" />
              <span className="px-3 text-xs text-slate-400 font-data">min</span>
            </div>
          </div>
          <span className="block text-xs text-slate-400 mt-1">Sugerido pelo produto: {horasFmt(sugeridoMin / 60)} ({num(qtd) || 1}×). Deixe vazio para usar.</span>
        </div>
        <div className="p-3 rounded-lg text-xs text-slate-500" style={{ background: "#f8fafc" }}>
          Ao concluir, somo <b>{num(qtd) || 1}</b> ao estoque de <b>{prod ? prod.nome : "—"}</b> e baixo <b>{num((prod ? prod.gramasUsadas : 0) * (parseNum(qtd) || 1))} g</b> de {fil ? fil.nome : "filamento"}.
        </div>
      </div>
    </Modal>
  );
}

// === Filamentos ===
function Filamentos({ filaments, onAdd, onEdit, onDelete }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-xl font-bold" style={{ color: "var(--ink)" }}>Filamentos</h2>
          <p className="text-sm text-slate-500">{filaments.length} cadastrado{filaments.length === 1 ? "" : "s"}</p>
        </div>
        <PrimaryBtn onClick={onAdd}><Plus size={16} /> Novo filamento</PrimaryBtn>
      </div>
      {filaments.length === 0 ? (
        <EmptyState icon={Boxes} title="Nenhum filamento ainda" desc="Registre cada compra com peso e valor. O custo por grama é calculado automaticamente.">
          <PrimaryBtn onClick={onAdd}><Plus size={16} /> Cadastrar primeiro filamento</PrimaryBtn>
        </EmptyState>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filaments.map((f) => {
            const cpg = custoPorGrama(f);
            const pct = f.pesoCompradoG ? Math.max(0, Math.min(100, (f.pesoEstoqueG / f.pesoCompradoG) * 100)) : 0;
            const baixo = (f.pesoEstoqueG || 0) <= (f.alertaG || 0);
            return (
              <Card key={f.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-4 h-4 rounded-full shrink-0" style={{ background: f.cor, border: "1px solid rgba(0,0,0,.1)" }} />
                    <span className="font-semibold truncate" style={{ color: "var(--ink)" }}>{f.nome}</span>
                  </div>
                  <Chip>{f.tipo}</Chip>
                </div>
                {f.marca && <p className="text-xs text-slate-400 mt-0.5">{f.marca}</p>}
                <div className="mt-3 flex items-baseline justify-between">
                  <span className="text-xs text-slate-500">Custo / grama</span>
                  <span className="font-data font-semibold" style={{ color: "var(--ink)" }}>{brl(cpg)}</span>
                </div>
                <div className="mt-3">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-slate-500">Estoque</span>
                    <span className="font-data" style={{ color: baixo ? "#e11d48" : "var(--ink)" }}>{num(f.pesoEstoqueG)} / {num(f.pesoCompradoG)} g</span>
                  </div>
                  <div className="h-2 rounded-full overflow-hidden" style={{ background: "#eef0f3" }}>
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: baixo ? "#e11d48" : "var(--accent)" }} />
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-xs text-slate-500">Valor em estoque</span>
                  <span className="font-data text-sm" style={{ color: "var(--ink)" }}>{brl((f.pesoEstoqueG || 0) * cpg)}</span>
                </div>
                {baixo && <div className="mt-2 flex items-center gap-1 text-xs text-rose-600"><AlertTriangle size={13} /> Estoque baixo</div>}
                <div className="mt-3 flex gap-1 pt-3" style={{ borderTop: "1px solid var(--line)" }}>
                  <button onClick={() => onEdit(f)} className="flex-1 inline-flex items-center justify-center gap-1 text-xs font-medium py-1.5 rounded-lg hover:bg-slate-100 transition text-slate-600"><Pencil size={13} /> Editar</button>
                  <button onClick={() => onDelete(f)} className="flex-1 inline-flex items-center justify-center gap-1 text-xs font-medium py-1.5 rounded-lg hover:bg-rose-50 transition text-rose-600"><Trash2 size={13} /> Excluir</button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FilamentForm({ initial, onSave, onClose }) {
  const [f, setF] = useState(initial || { nome: "", marca: "", tipo: "PLA", cor: "#1c1c1c", pesoCompradoG: "1000", custoCompra: "", pesoEstoqueG: "", alertaG: "150" });
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  const cpg = parseNum(f.custoCompra) && parseNum(f.pesoCompradoG) ? parseNum(f.custoCompra) / parseNum(f.pesoCompradoG) : 0;
  const save = () => {
    if (!f.nome.trim()) return;
    const peso = parseNum(f.pesoCompradoG);
    onSave({ id: f.id || uid(), nome: f.nome.trim(), marca: f.marca.trim(), tipo: f.tipo, cor: f.cor, pesoCompradoG: peso, custoCompra: parseNum(f.custoCompra), pesoEstoqueG: f.pesoEstoqueG === "" ? peso : parseNum(f.pesoEstoqueG), alertaG: parseNum(f.alertaG) });
  };
  return (
    <Modal title={initial ? "Editar filamento" : "Novo filamento"} subtitle="Dados da compra e do estoque atual" onClose={onClose}
      footer={<><GhostBtn onClick={onClose}>Cancelar</GhostBtn><PrimaryBtn onClick={save}>Salvar</PrimaryBtn></>}>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2"><Field label="Nome" value={f.nome} onChange={set("nome")} placeholder="Ex.: PLA Preto" /></div>
        <Field label="Marca" value={f.marca} onChange={set("marca")} placeholder="Ex.: 3D Lab" />
        <Field label="Tipo" value={f.tipo} onChange={set("tipo")} options={TIPOS} />
        <Field label="Cor" value={f.cor} onChange={set("cor")} color />
        <div />
        <Field label="Peso do rolo comprado" value={f.pesoCompradoG} onChange={set("pesoCompradoG")} suffix="g" type="num" />
        <Field label="Valor pago no rolo" value={f.custoCompra} onChange={set("custoCompra")} suffix="R$" type="num" />
        <Field label="Estoque atual" value={f.pesoEstoqueG} onChange={set("pesoEstoqueG")} suffix="g" type="num" help="Vazio = usa o peso total do rolo." />
        <Field label="Alerta de estoque baixo" value={f.alertaG} onChange={set("alertaG")} suffix="g" type="num" />
      </div>
      <div className="mt-4 p-3 rounded-lg flex items-center justify-between" style={{ background: "var(--accent-soft)" }}>
        <span className="text-sm font-medium" style={{ color: "var(--accent-deep)" }}>Custo por grama</span>
        <span className="font-data font-semibold" style={{ color: "var(--accent-deep)" }}>{brl(cpg)}</span>
      </div>
    </Modal>
  );
}

// === Produtos ===
function Produtos({ products, filaments, config, onAdd, onEdit, onDelete, go }) {
  if (filaments.length === 0) {
    return (
      <EmptyState icon={Layers} title="Cadastre um filamento primeiro" desc="Os produtos usam o filamento como base de custo. Comece registrando ao menos um filamento.">
        <PrimaryBtn onClick={() => go("filamentos")}><Plus size={16} /> Ir para filamentos</PrimaryBtn>
      </EmptyState>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-xl font-bold" style={{ color: "var(--ink)" }}>Produtos</h2>
          <p className="text-sm text-slate-500">{products.length} cadastrado{products.length === 1 ? "" : "s"}</p>
        </div>
        <PrimaryBtn onClick={onAdd}><Plus size={16} /> Novo produto</PrimaryBtn>
      </div>
      {products.length === 0 ? (
        <EmptyState icon={Package} title="Nenhum produto ainda" desc="Crie um produto, escolha o filamento e o tempo de impressão. O custo e o preço sugerido aparecem na hora.">
          <PrimaryBtn onClick={onAdd}><Plus size={16} /> Criar primeiro produto</PrimaryBtn>
        </EmptyState>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {products.map((p) => {
            const fil = filaments.find((f) => f.id === p.filamentoId);
            const c = calcProduto(p, fil, config);
            const lucroPos = c.lucro >= 0;
            return (
              <Card key={p.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold truncate" style={{ color: "var(--ink)" }}>{p.nome}</span>
                  <Chip color="#eef2ff"><ShoppingBag size={11} /> {p.plataforma}</Chip>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: fil ? fil.cor : "#ccc" }} />{fil ? fil.nome : "filamento removido"}</span>
                  <span className="flex items-center gap-1"><Boxes size={12} /> {num(p.gramasUsadas)} g</span>
                  <span className="flex items-center gap-1"><Clock size={12} /> {horasFmt(p.tempoHoras)}</span>
                  {p.estoqueProduto > 0 && <Chip>{num(p.estoqueProduto)} em estoque</Chip>}
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center py-3 rounded-lg" style={{ background: "#f8fafc" }}>
                  <div><div className="text-xs text-slate-400">{config.metodoPrecificacao === "markup_divisor" ? "Custo Total" : "Custo Unit."}</div><div className="font-data text-sm" style={{ color: "var(--ink)" }}>{brl(config.metodoPrecificacao === "markup_divisor" ? c.custoTotalProduto : c.custoTotal + c.custoArmazenagem)}</div></div>
                  <div><div className="text-xs text-slate-400">Preço</div><div className="font-data text-sm font-semibold" style={{ color: "var(--ink)" }}>{brl(c.preco)}</div></div>
                  <div><div className="text-xs text-slate-400">Lucro</div><div className="font-data text-sm font-semibold" style={{ color: lucroPos ? "#059669" : "#e11d48" }}>{brl(c.lucro)}</div></div>
                </div>
                <p className="text-xs text-slate-400 mt-1.5 text-center">
                  {config.metodoPrecificacao === "markup_divisor"
                    ? `${num(c.margem)}% margem lucro · margem real ${num(c.margemReal)}% · taxa ${num(c.taxa, 1)}%`
                    : `margem de ${num(c.margemReal)}% sobre custo · taxa ${num(c.taxa, 1)}%`
                  }
                </p>
                <div className="mt-3 flex gap-1 pt-3" style={{ borderTop: "1px solid var(--line)" }}>
                  <button onClick={() => onEdit(p)} className="flex-1 inline-flex items-center justify-center gap-1 text-xs font-medium py-1.5 rounded-lg hover:bg-slate-100 transition text-slate-600"><Pencil size={13} /> Editar</button>
                  <button onClick={() => onDelete(p)} className="flex-1 inline-flex items-center justify-center gap-1 text-xs font-medium py-1.5 rounded-lg hover:bg-rose-50 transition text-rose-600"><Trash2 size={13} /> Excluir</button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProductForm({ initial, filaments, config, onSave, onClose }) {
  const plats = (config.plataformas || []).map((p) => p.nome);
  const splitH = initial ? Math.floor(initial.tempoHoras || 0) : "";
  const splitM = initial ? Math.round(((initial.tempoHoras || 0) % 1) * 60) : "";
  const [p, setP] = useState(
    initial
      ? { ...initial, horas: String(splitH), minutos: String(splitM), gramasUsadas: String(initial.gramasUsadas ?? ""), custosExtras: String(initial.custosExtras ?? ""), custoArmazenagem: String(initial.custoArmazenagem ?? ""), margem: initial.margem != null ? String(initial.margem) : "", precoVenda: initial.precoVenda ? String(initial.precoVenda) : "", estoqueProduto: String(initial.estoqueProduto ?? "") }
      : { nome: "", filamentoId: filaments[0] ? filaments[0].id : "", gramasUsadas: "", horas: "", minutos: "", custosExtras: "", custoArmazenagem: "", plataforma: plats[0] || "", margem: "", precoVenda: "", estoqueProduto: "" }
  );
  const set = (k) => (v) => setP((s) => ({ ...s, [k]: v }));
  const fil = filaments.find((f) => f.id === p.filamentoId);
  const draft = { gramasUsadas: parseNum(p.gramasUsadas), tempoHoras: parseNum(p.horas) + parseNum(p.minutos) / 60, custosExtras: parseNum(p.custosExtras), custoArmazenagem: parseNum(p.custoArmazenagem), plataforma: p.plataforma, margem: p.margem === "" ? null : parseNum(p.margem), precoVenda: parseNum(p.precoVenda) };
  const c = calcProduto(draft, fil, config);
  const save = () => {
    if (!p.nome.trim() || !p.filamentoId) return;
    onSave({ id: p.id || uid(), nome: p.nome.trim(), filamentoId: p.filamentoId, gramasUsadas: parseNum(p.gramasUsadas), tempoHoras: parseNum(p.horas) + parseNum(p.minutos) / 60, custosExtras: parseNum(p.custosExtras), custoArmazenagem: parseNum(p.custoArmazenagem), plataforma: p.plataforma, margem: p.margem === "" ? null : parseNum(p.margem), precoVenda: parseNum(p.precoVenda) || null, estoqueProduto: parseNum(p.estoqueProduto) });
  };
  const filOptions = filaments.map((f) => f.nome);
  const filByName = (nome) => filaments.find((f) => f.nome === nome);

  const despesasFixasPct = (config.despesasFixasMensais || 0) / (config.faturamentoMensal || 1) * 100;
  const impostosPct = config.impostosPct || 0;

  return (
    <Modal wide title={initial ? "Editar produto" : "Novo produto"} subtitle="Custo e preço calculados em tempo real" onClose={onClose}
      footer={<><GhostBtn onClick={onClose}>Cancelar</GhostBtn><PrimaryBtn onClick={save}>Salvar</PrimaryBtn></>}>
      <div className="grid lg:grid-cols-2 gap-5">
        <div className="space-y-4">
          <Field label="Nome do produto" value={p.nome} onChange={set("nome")} placeholder="Ex.: Vaso geométrico" />
          <Field label="Filamento" value={fil ? fil.nome : ""} onChange={(nome) => set("filamentoId")(filByName(nome)?.id || "")} options={filOptions} />
          
          <div className="grid grid-cols-2 gap-3">
            <Field label="Filamento usado" value={p.gramasUsadas} onChange={set("gramasUsadas")} suffix="g" type="num" />
            <Field label="Unidades em estoque" value={p.estoqueProduto} onChange={set("estoqueProduto")} suffix="un" type="num" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Custos extras" value={p.custosExtras} onChange={set("custosExtras")} suffix="R$" type="num" help="Embalagem, frete, etc." />
            <Field label="Armazenagem (estoque)" value={p.custoArmazenagem} onChange={set("custoArmazenagem")} suffix="R$" type="num" help="Custo por unidade." />
          </div>

          <div>
            <span className="block text-xs font-medium text-slate-500 mb-1">Tempo de impressão</span>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center rounded-lg bg-white overflow-hidden" style={{ border: "1px solid var(--line)" }}>
                <input value={p.horas} inputMode="decimal" onChange={(e) => set("horas")(e.target.value)} placeholder="0" className="w-full bg-transparent px-3 py-2 text-sm font-data outline-none" /><span className="px-3 text-xs text-slate-400 font-data">h</span>
              </div>
              <div className="flex items-center rounded-lg bg-white overflow-hidden" style={{ border: "1px solid var(--line)" }}>
                <input value={p.minutos} inputMode="decimal" onChange={(e) => set("minutos")(e.target.value)} placeholder="0" className="w-full bg-transparent px-3 py-2 text-sm font-data outline-none" /><span className="px-3 text-xs text-slate-400 font-data">min</span>
              </div>
            </div>
          </div>
          
          <Field label="Canal principal de venda" value={p.plataforma} onChange={set("plataforma")} options={plats.length ? plats : ["—"]} help="Usado no preço sugerido. A venda real você escolhe ao registrar." />
          
          <Field 
            label={config.metodoPrecificacao === "markup_divisor" ? "Margem de lucro (%)" : "Margem sobre custo"} 
            value={p.margem} 
            onChange={set("margem")} 
            suffix="%" 
            type="num" 
            help={`Padrão: ${config.margemPadrao}%`} 
          />

          <Field label="Preço de venda (opcional)" value={p.precoVenda} onChange={set("precoVenda")} suffix="R$" type="num" help="Vazio = usa o preço sugerido." />
        </div>
        <div>
          <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--line)" }}>
            <div className="px-4 py-3" style={{ background: "#14181F" }}><span className="text-xs font-medium uppercase tracking-wide text-slate-300">Composição do custo de produção</span></div>
            <div className="p-4 space-y-2 text-sm bg-white">
              <Row label={`Filamento (${num(draft.gramasUsadas)} g × ${brl(c.cpg)})`} value={brl(c.custoFil)} />
              <Row label={`Energia (${horasFmt(draft.tempoHoras)} · ${config.potenciaW} W)`} value={brl(c.custoEnergia)} />
              {config.maoDeObraHora > 0 && <Row label="Mão de obra" value={brl(c.custoMao)} />}
              <Row label="Custos extras" value={brl(c.extras)} />
              {c.custoArmazenagem > 0 && <Row label="Armazenagem" value={brl(c.custoArmazenagem)} />}
              <Row label={`Buffer de falha (${config.custoFalhaPct}%)`} value={brl(c.buffer)} />
              <div className="flex items-center justify-between pt-2 mt-1" style={{ borderTop: "1px dashed var(--line)" }}>
                <span className="font-semibold" style={{ color: "var(--ink)" }}>Custo unitário base</span><span className="font-data font-bold" style={{ color: "var(--ink)" }}>{brl(c.custoTotal + c.custoArmazenagem)}</span>
              </div>
            </div>

            {config.metodoPrecificacao === "markup_divisor" && (
              <div className="p-4 space-y-2 text-sm bg-white" style={{ borderTop: "1px solid var(--line)" }}>
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Impostos e Rateio Fixo (estimado)</div>
                <Row label={`Taxa de canal (${num(c.taxa, 1)}%)`} value={brl(c.precoSugerido * (c.taxa / 100))} />
                <Row label={`Impostos sobre venda (${num(impostosPct, 1)}%)`} value={brl(c.precoSugerido * (impostosPct / 100))} />
                <Row label={`Custo fixo rateado (${num(despesasFixasPct, 1)}%)`} value={brl(c.precoSugerido * (despesasFixasPct / 100))} />
                <div className="flex items-center justify-between pt-2" style={{ borderTop: "1px dashed var(--line)" }}>
                  <span className="font-semibold" style={{ color: "var(--ink)" }}>Custo Total do Produto</span><span className="font-data font-bold" style={{ color: "var(--ink)" }}>{brl(c.custoTotalProduto)}</span>
                </div>
              </div>
            )}

            <div className="p-4 space-y-2" style={{ background: "var(--accent-soft)" }}>
              <div className="flex items-center justify-between"><span className="text-sm" style={{ color: "var(--accent-deep)" }}>Preço sugerido</span><span className="font-data font-bold text-lg" style={{ color: "var(--accent-deep)" }}>{brl(c.precoSugerido)}</span></div>
              <p className="text-xs" style={{ color: "var(--accent-deep)" }}>
                {config.metodoPrecificacao === "markup_divisor" 
                  ? `para margem de lucro de ${num(c.margem)}% do preço final (Nuvemshop).`
                  : `para margem de ${num(c.margem)}% sobre o custo, já cobrindo a taxa de ${num(c.taxa, 1)}% do canal.`
                }
              </p>
            </div>
            {draft.precoVenda > 0 && (
              <div className="p-4 space-y-2 text-sm bg-white" style={{ borderTop: "1px solid var(--line)" }}>
                <Row label="Preço de venda" value={brl(draft.precoVenda)} />
                {config.metodoPrecificacao === "markup_divisor" ? (
                  <>
                    <Row label={`Taxa de canal (${num(c.taxa, 1)}%)`} value={brl(draft.precoVenda * (c.taxa / 100))} />
                    <Row label={`Impostos sobre venda (${num(impostosPct, 1)}%)`} value={brl(draft.precoVenda * (impostosPct / 100))} />
                    <Row label={`Custo fixo rateado (${num(despesasFixasPct, 1)}%)`} value={brl(draft.precoVenda * (despesasFixasPct / 100))} />
                  </>
                ) : (
                  <Row label={`Receita após taxa (${num(c.taxa, 1)}%)`} value={brl(c.receitaLiquida)} />
                )}
                <div className="flex items-center justify-between pt-2" style={{ borderTop: "1px dashed var(--line)" }}>
                  <span className="font-semibold" style={{ color: "var(--ink)" }}>Lucro por unidade</span><span className="font-data font-bold" style={{ color: c.lucro >= 0 ? "#059669" : "#e11d48" }}>{brl(c.lucro)}</span>
                </div>
                <p className="text-xs text-slate-400 text-right">
                  {config.metodoPrecificacao === "markup_divisor"
                    ? `margem real de ${num(c.margemReal)}% sobre o custo unitário`
                    : `margem de ${num(c.margemReal)}% sobre o custo`
                  }
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// === Vendas ===
function Vendas({ sales, products, filaments, config, onAdd, onDelete, go, onExportCSV }) {
  const [periodo, setPeriodo] = useState("mes");
  const stats = useVendaStats(sales, products, filaments, config, periodo);
  if (products.length === 0) {
    return (
      <EmptyState icon={Package} title="Cadastre produtos primeiro" desc="As vendas são registradas a partir dos seus produtos.">
        <PrimaryBtn onClick={() => go("produtos")}><Plus size={16} /> Ir para produtos</PrimaryBtn>
      </EmptyState>
    );
  }
  const recent = sales.slice().sort((a, b) => (b.data || "").localeCompare(a.data || "")).slice(0, 30);
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="font-display text-xl font-bold" style={{ color: "var(--ink)" }}>Vendas e faturamento</h2>
          <p className="text-sm text-slate-500">{sales.length} venda{sales.length === 1 ? "" : "s"} registrada{sales.length === 1 ? "" : "s"}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg overflow-hidden" style={{ border: "1px solid var(--line)" }}>
            {[["mes", "Este mês"], ["tudo", "Tudo"]].map(([k, lbl]) => (
              <button key={k} onClick={() => setPeriodo(k)} className="text-sm px-3 py-2 font-medium" style={{ background: periodo === k ? "var(--accent)" : "#fff", color: periodo === k ? "#fff" : "#64748b" }}>{lbl}</button>
            ))}
          </div>
          {sales.length > 0 && (
            <GhostBtn onClick={onExportCSV}><Download size={16} /> Exportar Excel</GhostBtn>
          )}
          <PrimaryBtn onClick={onAdd}><Plus size={16} /> Registrar venda</PrimaryBtn>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={CircleDollarSign} label="Faturamento" value={brl(stats.fat)} sub={periodo === "mes" ? "no mês" : "total"} accent />
        <Kpi icon={TrendingUp} label="Lucro" value={brl(stats.lucro)} sub="após taxas e custo" />
        <Kpi icon={ShoppingCart} label="Pedidos" value={num(stats.pedidos)} sub={`${num(stats.itens)} itens`} />
        <Kpi icon={Tag} label="Ticket médio" value={brl(stats.ticket)} sub="por pedido" />
      </div>

      {stats.count === 0 ? (
        <EmptyState icon={ShoppingCart} title="Nenhuma venda neste período" desc="Registre suas vendas do Mercado Livre, Shopee e onde mais vender para acompanhar o que sai mais.">
          <PrimaryBtn onClick={onAdd}><Plus size={16} /> Registrar primeira venda</PrimaryBtn>
        </EmptyState>
      ) : (
        <>
          <div className="grid lg:grid-cols-2 gap-4">
            <Card className="p-5">
              <h3 className="font-display font-semibold mb-3" style={{ color: "var(--ink)" }}>Faturamento por plataforma</h3>
              <div style={{ width: "100%", height: 240 }}>
                <ResponsiveContainer>
                  <BarChart data={stats.platBars} margin={{ top: 4, right: 8, left: -8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" vertical={false} />
                    <XAxis dataKey="nome" tick={{ fontSize: 11, fill: "#94a3b8" }} interval={0} />
                    <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} width={42} />
                    <Tooltip formatter={(v) => brl(v)} contentStyle={{ borderRadius: 10, border: "1px solid var(--line)", fontSize: 12 }} />
                    <Bar dataKey="Faturamento" radius={[4, 4, 0, 0]}>{stats.platBars.map((e, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card className="p-5">
              <h3 className="font-display font-semibold mb-3" style={{ color: "var(--ink)" }}>Produtos que mais saem</h3>
              <div style={{ width: "100%", height: 240 }}>
                <ResponsiveContainer>
                  <BarChart layout="vertical" data={stats.topProdutos.slice(0, 6).map((x) => ({ nome: shorten(x.nome, 16), Unidades: x.qtd }))} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11, fill: "#94a3b8" }} allowDecimals={false} />
                    <YAxis type="category" dataKey="nome" tick={{ fontSize: 11, fill: "#94a3b8" }} width={96} />
                    <Tooltip formatter={(v) => `${num(v)} un`} contentStyle={{ borderRadius: 10, border: "1px solid var(--line)", fontSize: 12 }} />
                    <Bar dataKey="Unidades" fill="#F25C05" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <Card className="p-5">
            <h3 className="font-display font-semibold mb-3" style={{ color: "var(--ink)" }}>Mais vendido em cada plataforma</h3>
            <div className="space-y-2">
              {stats.maisPorPlataforma.map((m) => (
                <div key={m.plataforma} className="flex items-center justify-between text-sm py-1">
                  <Chip color="#eef2ff"><ShoppingBag size={11} /> {m.plataforma}</Chip>
                  <span className="flex items-center gap-2"><span style={{ color: "var(--ink)" }}>{m.produto}</span><span className="font-data text-slate-400">{num(m.qtd)} un</span></span>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}

      <Card className="p-5">
        <h3 className="font-display font-semibold mb-3" style={{ color: "var(--ink)" }}>Vendas recentes</h3>
        {recent.length === 0 ? (
          <p className="text-sm text-slate-400">Nenhuma venda registrada ainda.</p>
        ) : (
          <div className="divide-y" style={{ borderColor: "var(--line)" }}>
            {recent.map((s) => (
              <div key={s.id} className="flex items-center justify-between py-2.5 gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate" style={{ color: "var(--ink)" }}>{s.produtoNome}</div>
                  <div className="text-xs text-slate-400 flex items-center gap-2">
                    <Chip color="#eef2ff">{s.plataforma}</Chip>
                    <span className="font-data">{(s.data || "").split("-").reverse().join("/")}</span>
                    <span className="font-data">{num(s.quantidade)}× {brl(s.precoUnit)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="font-data text-sm font-semibold" style={{ color: "var(--ink)" }}>{brl((s.precoUnit || 0) * (s.quantidade || 0))}</span>
                  <button onClick={() => onDelete(s)} className="p-1.5 rounded-lg hover:bg-rose-50 text-rose-500 transition"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function SaleForm({ products, filaments, config, onSave, onClose }) {
  const plats = (config.plataformas || []).map((p) => p.nome);
  const [produtoId, setProdutoId] = useState(products[0] ? products[0].id : "");
  const prod = products.find((p) => p.id === produtoId);
  const fil = prod ? filaments.find((f) => f.id === prod.filamentoId) : null;
  const sugerido = prod ? calcProduto(prod, fil, config).preco : 0;
  const [plataforma, setPlataforma] = useState((prod && prod.plataforma) || plats[0] || "");
  const [quantidade, setQuantidade] = useState("1");
  const [precoUnit, setPrecoUnit] = useState(prod ? String(+sugerido.toFixed(2)) : "");
  const [data, setData] = useState(todayISO());

  const pickProduct = (nome) => {
    const found = products.find((p) => p.nome === nome);
    setProdutoId(found ? found.id : "");
    if (found) {
      const f2 = filaments.find((f) => f.id === found.filamentoId);
      setPrecoUnit(String(+calcProduto(found, f2, config).preco.toFixed(2)));
      if (found.plataforma) setPlataforma(found.plataforma);
    }
  };
  const draftSale = { produtoId, plataforma, quantidade: parseNum(quantidade), precoUnit: parseNum(precoUnit) };
  const cv = calcVenda(draftSale, prod, fil, config);
  const save = () => {
    if (!prod) return;
    onSave({ id: uid(), produtoId: prod.id, produtoNome: prod.nome, plataforma, quantidade: parseNum(quantidade) || 1, precoUnit: parseNum(precoUnit), data });
  };
  const opts = products.map((p) => p.nome);
  return (
    <Modal title="Registrar venda" subtitle="Baixa do estoque do produto automaticamente" onClose={onClose}
      footer={<><GhostBtn onClick={onClose}>Cancelar</GhostBtn><PrimaryBtn onClick={save}>Salvar venda</PrimaryBtn></>}>
      <div className="space-y-4">
        <Field label="Produto" value={prod ? prod.nome : ""} onChange={pickProduct} options={opts} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Plataforma" value={plataforma} onChange={setPlataforma} options={plats.length ? plats : ["—"]} />
          <Field label="Data" value={data} onChange={setData} type="date" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantidade" value={quantidade} onChange={setQuantidade} suffix="un" type="num" />
          <Field label="Preço unitário" value={precoUnit} onChange={setPrecoUnit} suffix="R$" type="num" help="Preenchido pelo preço do produto." />
        </div>
        <div className="rounded-lg p-3 space-y-1.5 text-sm" style={{ background: "#f8fafc" }}>
          <Row label="Faturamento" value={brl(cv.receitaBruta)} />
          <Row label={`Receita após taxa (${num(cv.fee, 1)}%)`} value={brl(cv.receitaLiq)} />
          <div className="flex items-center justify-between pt-1.5" style={{ borderTop: "1px dashed var(--line)" }}>
            <span className="font-semibold" style={{ color: "var(--ink)" }}>Lucro estimado</span>
            <span className="font-data font-bold" style={{ color: cv.lucro >= 0 ? "#059669" : "#e11d48" }}>{brl(cv.lucro)}</span>
          </div>
          {prod && prod.estoqueProduto != null && <p className="text-xs text-slate-400">Estoque após a venda: {num(Math.max(0, (prod.estoqueProduto || 0) - (parseNum(quantidade) || 0)))} un</p>}
        </div>
      </div>
    </Modal>
  );
}

function Configuracoes({ config, setConfig, onSeed, onClear, onExport, onImport }) {
  const set = (k) => (v) => setConfig((c) => ({ ...c, [k]: parseNum(v) }));
  const fileRef = useRef(null);
  const updPlat = (id, field, val) => setConfig((c) => ({ ...c, plataformas: c.plataformas.map((p) => (p.id === id ? { ...p, [field]: field === "taxa" ? val : val } : p)) }));
  const addPlat = () => setConfig((c) => ({ ...c, plataformas: [...(c.plataformas || []), { id: uid(), nome: "Nova plataforma", taxa: 0 }] }));
  const delPlat = (id) => setConfig((c) => ({ ...c, plataformas: c.plataformas.filter((p) => p.id !== id) }));

  const despesasFixasPct = (config.despesasFixasMensais || 0) / (config.faturamentoMensal || 1) * 100;

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h2 className="font-display text-xl font-bold" style={{ color: "var(--ink)" }}>Configurações</h2>
        <p className="text-sm text-slate-500">Os parâmetros abaixo alimentam o cálculo de custo e de lucro.</p>
      </div>

      <Card className="p-5">
        <div className="flex items-center gap-2 mb-2"><TrendingUp size={16} style={{ color: "var(--accent)" }} /><h3 className="font-display font-semibold" style={{ color: "var(--ink)" }}>Método de precificação</h3></div>
        <p className="text-sm text-slate-500 mb-4">Escolha a fórmula usada para sugerir seus preços e calcular os lucros.</p>
        <div className="space-y-4">
          <Field 
            label="Fórmula de cálculo" 
            value={config.metodoPrecificacao === "markup_divisor" ? "Margem sobre Preço (Nuvemshop)" : "Markup sobre Custo (Atual)"} 
            onChange={(val) => setConfig((c) => ({ ...c, metodoPrecificacao: val === "Margem sobre Preço (Nuvemshop)" ? "markup_divisor" : "markup_custo" }))} 
            options={["Markup sobre Custo (Atual)", "Margem sobre Preço (Nuvemshop)"]} 
          />

          {config.metodoPrecificacao === "markup_divisor" && (
            <div className="p-4 rounded-lg bg-slate-50 border border-slate-100 space-y-4">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Despesas Fixas e Impostos da Loja</div>
              <div className="grid sm:grid-cols-3 gap-4">
                <Field label="Despesas fixas mensais" value={config.despesasFixasMensais} onChange={set("despesasFixasMensais")} suffix="R$/mês" type="num" help="Aluguel, salários, software, etc." />
                <Field label="Faturamento mensal aproximado" value={config.faturamentoMensal} onChange={set("faturamentoMensal")} suffix="R$" type="num" help="Faturamento médio estimado." />
                <Field label="Impostos sobre venda" value={config.impostosPct} onChange={set("impostosPct")} suffix="%" type="num" help="Simples Nacional, DAS, ICMS, etc." />
              </div>
              <div className="pt-3 border-t border-dashed border-slate-200 flex items-center justify-between text-xs text-slate-500">
                <span>Participação de custos fixos no faturamento (DF %):</span>
                <span className="font-data font-semibold text-slate-700">{num(despesasFixasPct, 2)}%</span>
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2 mb-4"><Zap size={16} style={{ color: "var(--accent)" }} /><h3 className="font-display font-semibold" style={{ color: "var(--ink)" }}>Custos de operação da impressora</h3></div>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Custo da energia" value={config.energiaKwh} onChange={set("energiaKwh")} suffix="R$/kWh" type="num" help="Veja na sua conta de luz." />
          <Field label="Potência média da impressora" value={config.potenciaW} onChange={set("potenciaW")} suffix="W" type="num" help="FDM costuma ficar entre 100 e 200 W." />
          <Field label="Mão de obra / operação" value={config.maoDeObraHora} onChange={set("maoDeObraHora")} suffix="R$/h" type="num" help="Seu tempo de preparo e acabamento. 0 se não quiser cobrar." />
          <Field label="Buffer de falha" value={config.custoFalhaPct} onChange={set("custoFalhaPct")} suffix="%" type="num" help="Margem para impressões que falham ou desperdício." />
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2 mb-2"><CircleDollarSign size={16} style={{ color: "var(--accent)" }} /><h3 className="font-display font-semibold" style={{ color: "var(--ink)" }}>Margem e plataformas</h3></div>
        <p className="text-sm text-slate-500 mb-4">Adicione as plataformas onde você vende e a taxa de cada uma. Você pode renomear, criar e remover livremente.</p>
        <div className="max-w-xs mb-4">
          <Field 
            label={config.metodoPrecificacao === "markup_divisor" ? "Margem padrão (%)" : "Margem padrão sobre custo (%)"} 
            value={config.margemPadrao} 
            onChange={set("margemPadrao")} 
            suffix="%" 
            type="num" 
            help={`Padrão: ${config.margemPadrao}%`} 
          />
        </div>
        <div className="space-y-2">
          {(config.plataformas || []).map((p) => (
            <div key={p.id} className="flex items-center gap-2">
              <div className="flex-1 flex items-center rounded-lg bg-white overflow-hidden" style={{ border: "1px solid var(--line)" }}>
                <input value={p.nome} onChange={(e) => updPlat(p.id, "nome", e.target.value)} className="w-full bg-transparent px-3 py-2 text-sm outline-none ui" />
              </div>
              <div className="flex items-center rounded-lg bg-white overflow-hidden w-28" style={{ border: "1px solid var(--line)" }}>
                <input value={p.taxa} inputMode="decimal" onChange={(e) => updPlat(p.id, "taxa", parseNum(e.target.value))} className="w-full bg-transparent px-3 py-2 text-sm font-data outline-none" /><span className="px-2 text-xs text-slate-400 font-data">%</span>
              </div>
              <button onClick={() => delPlat(p.id)} className="p-2 rounded-lg hover:bg-rose-50 text-rose-500 transition"><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
        <button onClick={addPlat} className="mt-3 inline-flex items-center gap-1 text-sm font-medium" style={{ color: "var(--accent)" }}><Plus size={15} /> Adicionar plataforma</button>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2 mb-1"><Database size={16} style={{ color: "var(--accent)" }} /><h3 className="font-display font-semibold" style={{ color: "var(--ink)" }}>Dados</h3></div>
        <p className="text-sm text-slate-500 mb-4">Tudo é salvo automaticamente neste navegador. Use o backup para não perder nada.</p>
        <div className="flex flex-wrap gap-2">
          <GhostBtn onClick={onSeed}><Layers size={15} /> Carregar exemplo</GhostBtn>
          <GhostBtn onClick={onExport}><Download size={15} /> Exportar backup</GhostBtn>
          <GhostBtn onClick={() => fileRef.current && fileRef.current.click()}><Upload size={15} /> Importar backup</GhostBtn>
          <button onClick={onClear} className="inline-flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg text-rose-600 hover:bg-rose-50 transition" style={{ border: "1px solid #fecdd3" }}><Trash2 size={15} /> Limpar tudo</button>
          <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => { const file = e.target.files[0]; if (file) onImport(file); e.target.value = ""; }} />
        </div>
      </Card>
    </div>
  );
}

// === App ===
export default function App() {
  const [tab, setTab] = useState("painel");
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [filaments, setFilaments] = useState([]);
  const [products, setProducts] = useState([]);
  const [printers, setPrinters] = useState([]);
  const [sales, setSales] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [savedAt, setSavedAt] = useState(null);
  const [now, setNow] = useState(Date.now());

  const [filModal, setFilModal] = useState(null);
  const [prodModal, setProdModal] = useState(null);
  const [printerModal, setPrinterModal] = useState(null);
  const [jobModal, setJobModal] = useState(null);   // printer
  const [saleModal, setSaleModal] = useState(false);

  // Estados de Autenticação do Firebase
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState("login"); // "login" | "register"
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [isActive, setIsActive] = useState(false);
  const [expiresAt, setExpiresAt] = useState(null);
  const lastFetchedDataRef = useRef("");

  /* relógio para progresso ao vivo */
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(i);
  }, []);

  // Trata o retorno de pagamento do Mercado Pago (Callback Redirects)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("status");
    if (status === "rejected") {
      setAuthError("O pagamento foi recusado pelo banco/cartão. Por favor, tente novamente.");
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (status === "cancelled") {
      setAuthError("O pagamento foi cancelado antes de ser concluído.");
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (status === "pending") {
      setAuthError("Seu pagamento está pendente de processamento. Assim que aprovado, seu painel será liberado!");
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (status === "approved") {
      // O acesso será liberado em tempo real pelo Firestore, limpamos apenas os parâmetros da URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // 1. Escuta mudanças no estado de autenticação
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (!currentUser) {
        // Limpa estados locais ao deslogar
        setConfig(DEFAULT_CONFIG);
        setFilaments([]);
        setProducts([]);
        setPrinters([]);
        setSales([]);
        setIsActive(false);
        lastFetchedDataRef.current = "";
        setLoaded(false);
        setAuthLoading(false);
      }
    });
    return () => unsubscribe();
  }, []);

  // 2. Escuta mudanças no Firestore quando logado
  useEffect(() => {
    if (!user) return;
    setLoaded(false);
    const docRef = doc(db, "users", user.uid);
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        const d = docSnap.data();
        const dataStr = JSON.stringify(d);
        lastFetchedDataRef.current = dataStr;

        let active = !!d.active;
        if (d.expiresAt) {
          const expiryDate = d.expiresAt.toDate();
          setExpiresAt(expiryDate);
          if (expiryDate < new Date()) {
            active = false;
          }
        } else {
          setExpiresAt(null);
        }
        setIsActive(active);
        if (d.config) setConfig(d.config);
        if (Array.isArray(d.filaments)) setFilaments(d.filaments);
        if (Array.isArray(d.products)) setProducts(d.products);
        if (Array.isArray(d.printers)) setPrinters(d.printers);
        if (Array.isArray(d.sales)) setSales(d.sales);
      } else {
        // Se o documento não existe, inicializa
        setIsActive(false);
        setExpiresAt(null);
        const initialStr = JSON.stringify({ config: DEFAULT_CONFIG, filaments: [], products: [], printers: [], sales: [] });
        lastFetchedDataRef.current = initialStr;
      }
      setLoaded(true);
      setAuthLoading(false);
    }, (error) => {
      console.error("Erro no listener do Firestore:", error);
      setAuthLoading(false);
      setStorageOk(false);
    });

    return () => unsubscribe();
  }, [user]);

  // 3. Salva no Firestore quando houver modificações locais
  useEffect(() => {
    if (!user || !loaded) return;
    const currentData = { config, filaments, products, printers, sales };
    const currentDataStr = JSON.stringify(currentData);

    // Evita loop infinito comparando com o último fetch do Firestore
    if (currentDataStr === lastFetchedDataRef.current) return;

    const save = async () => {
      try {
        lastFetchedDataRef.current = currentDataStr;
        await setDoc(doc(db, "users", user.uid), currentData, { merge: true });
        setSavedAt(Date.now());
        setStorageOk(true);
      } catch (e) {
        if (import.meta.env.DEV) console.error("Erro ao salvar no Firestore:", e);
        setStorageOk(false);
      }
    };

    // Debounce de 1 segundo para evitar chamadas excessivas ao Firestore
    const t = setTimeout(save, 1000);
    return () => clearTimeout(t);
  }, [config, filaments, products, printers, sales, user, loaded]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setAuthError("");
    setAuthLoading(true);
    try {
      await signInWithEmailAndPassword(auth, authEmail, authPassword);
    } catch (err) {
      if (import.meta.env.DEV) console.error(err);
      let errMsg = "Erro ao fazer login. Verifique as credenciais.";
      if (err.code === "auth/invalid-credential" || err.code === "auth/wrong-password" || err.code === "auth/user-not-found") {
        errMsg = "E-mail ou senha incorretos.";
      } else if (err.code === "auth/invalid-email") {
        errMsg = "Formato de e-mail inválido.";
      }
      setAuthError(errMsg);
      setAuthLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setAuthError("");
    if (!authEmail.trim() || !authPassword) {
      setAuthError("Preencha todos os campos.");
      return;
    }
    if (authPassword.length < 8) {
      setAuthError("A senha precisa ter no mínimo 8 caracteres.");
      return;
    }
    setAuthLoading(true);
    try {
      await createUserWithEmailAndPassword(auth, authEmail, authPassword);
    } catch (err) {
      if (import.meta.env.DEV) console.error(err);
      let errMsg = "Erro ao criar conta.";
      if (err.code === "auth/email-already-in-use") {
        errMsg = "Este e-mail já está em uso.";
      } else if (err.code === "auth/invalid-email") {
        errMsg = "Formato de e-mail inválido.";
      }
      setAuthError(errMsg);
      setAuthLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthError("");
    setAuthLoading(true);
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      if (import.meta.env.DEV) console.error(err);
      let errMsg = "Erro ao fazer login com o Google.";
      if (err.code === "auth/popup-closed-by-user") {
        errMsg = "O login do Google foi fechado antes de ser concluído.";
      } else if (err.code === "auth/cancelled-popup-request") {
        errMsg = "A solicitação de login do Google foi cancelada.";
      }
      setAuthError(errMsg);
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    if (window.confirm("Deseja realmente sair?")) {
      try {
        await signOut(auth);
      } catch (err) {
        if (import.meta.env.DEV) console.error("Erro ao sair:", err);
      }
    }
  };

  /* filamentos */
  const saveFil = (f) => { setFilaments((a) => a.some((x) => x.id === f.id) ? a.map((x) => (x.id === f.id ? f : x)) : [...a, f]); setFilModal(null); };
  const delFil = (f) => { if (window.confirm(`Excluir o filamento "${f.nome}"?`)) setFilaments((a) => a.filter((x) => x.id !== f.id)); };

  /* produtos */
  const saveProd = (p) => { setProducts((a) => a.some((x) => x.id === p.id) ? a.map((x) => (x.id === p.id ? p : x)) : [...a, p]); setProdModal(null); };
  const delProd = (p) => { if (window.confirm(`Excluir o produto "${p.nome}"?`)) setProducts((a) => a.filter((x) => x.id !== p.id)); };

  /* impressoras */
  const savePrinter = (pr) => { setPrinters((a) => a.some((x) => x.id === pr.id) ? a.map((x) => (x.id === pr.id ? pr : x)) : [...a, pr]); setPrinterModal(null); };
  const delPrinter = (pr) => { if (window.confirm(`Excluir a impressora "${pr.apelido}"?`)) setPrinters((a) => a.filter((x) => x.id !== pr.id)); };
  const setPrinterStatus = (pr, status) => setPrinters((a) => a.map((x) => (x.id === pr.id ? { ...x, status, job: status === "imprimindo" ? x.job : null } : x)));
  const startJob = (printerId, job) => { setPrinters((a) => a.map((x) => (x.id === printerId ? { ...x, status: "imprimindo", job } : x))); setJobModal(null); };
  const cancelJob = (pr) => setPrinters((a) => a.map((x) => (x.id === pr.id ? { ...x, status: "ociosa", job: null } : x)));
  const finishJob = (pr) => {
    const job = pr.job; if (!job) return;
    setProducts((a) => a.map((p) => (p.id === job.produtoId ? { ...p, estoqueProduto: (p.estoqueProduto || 0) + (job.qtd || 1) } : p)));
    const prod = products.find((p) => p.id === job.produtoId);
    if (prod) {
      const gasto = (prod.gramasUsadas || 0) * (job.qtd || 1);
      setFilaments((a) => a.map((f) => (f.id === prod.filamentoId ? { ...f, pesoEstoqueG: Math.max(0, (f.pesoEstoqueG || 0) - gasto) } : f)));
    }
    setPrinters((a) => a.map((x) => (x.id === pr.id ? { ...x, status: "ociosa", job: null, totalMin: (x.totalMin || 0) + (job.estimMin || 0) } : x)));
  };

  /* vendas */
  const saveSale = (s) => {
    setSales((a) => [...a, s]);
    setProducts((a) => a.map((p) => (p.id === s.produtoId ? { ...p, estoqueProduto: Math.max(0, (p.estoqueProduto || 0) - (s.quantidade || 0)) } : p)));
    setSaleModal(false);
  };
  const delSale = (s) => { if (window.confirm("Excluir esta venda?")) setSales((a) => a.filter((x) => x.id !== s.id)); };

  /* dados */
  const seed = () => {
    if (filaments.length || products.length || printers.length || sales.length) {
      if (!window.confirm("Isto substitui seus dados atuais pelo exemplo. Continuar?")) return;
    }
    const f1 = { id: uid(), nome: "PLA Preto", marca: "3D Lab", tipo: "PLA", cor: "#1c1c1c", pesoCompradoG: 1000, custoCompra: 120, pesoEstoqueG: 640, alertaG: 150 };
    const f2 = { id: uid(), nome: "PLA Branco", marca: "3D Lab", tipo: "PLA", cor: "#f2f2f2", pesoCompradoG: 1000, custoCompra: 120, pesoEstoqueG: 300, alertaG: 150 };
    const f3 = { id: uid(), nome: "PETG Azul", marca: "Voolt3D", tipo: "PETG", cor: "#1d4ed8", pesoCompradoG: 1000, custoCompra: 155, pesoEstoqueG: 120, alertaG: 150 };
    const p1 = { id: uid(), nome: "Vaso geométrico", filamentoId: f1.id, gramasUsadas: 85, tempoHoras: 4.5, custosExtras: 2.5, plataforma: "Mercado Livre", margem: null, precoVenda: 79.9, estoqueProduto: 6 };
    const p2 = { id: uid(), nome: "Luminária Lua", filamentoId: f2.id, gramasUsadas: 220, tempoHoras: 11, custosExtras: 18, plataforma: "Shopee", margem: null, precoVenda: 189.9, estoqueProduto: 3 };
    const p3 = { id: uid(), nome: "Suporte de headset", filamentoId: f3.id, gramasUsadas: 60, tempoHoras: 3, custosExtras: 0, plataforma: "Mercado Livre", margem: 100, precoVenda: 59.9, estoqueProduto: 4 };
    const ym = new Date().toISOString().slice(0, 7);
    const day = (d) => `${ym}-${String(d).padStart(2, "0")}`;
    setConfig(DEFAULT_CONFIG);
    setFilaments([f1, f2, f3]);
    setProducts([p1, p2, p3]);
    setPrinters([
      { id: uid(), apelido: "Bambu 1", marca: "Bambu Lab", modelo: "A1", status: "imprimindo", job: { produtoId: p1.id, produtoNome: p1.nome, startTime: Date.now() - 90 * 60000, estimMin: 270, qtd: 2 }, totalMin: 1860 },
      { id: uid(), apelido: "Bambu 2", marca: "Bambu Lab", modelo: "P1S", status: "ociosa", job: null, totalMin: 990 },
      { id: uid(), apelido: "Creality", marca: "Creality", modelo: "Ender 3 V3", status: "manutencao", job: null, totalMin: 420 },
    ]);
    setSales([
      { id: uid(), produtoId: p1.id, produtoNome: p1.nome, plataforma: "Mercado Livre", quantidade: 4, precoUnit: 79.9, data: day(3) },
      { id: uid(), produtoId: p1.id, produtoNome: p1.nome, plataforma: "Shopee", quantidade: 2, precoUnit: 74.9, data: day(6) },
      { id: uid(), produtoId: p2.id, produtoNome: p2.nome, plataforma: "Shopee", quantidade: 3, precoUnit: 189.9, data: day(8) },
      { id: uid(), produtoId: p3.id, produtoNome: p3.nome, plataforma: "Mercado Livre", quantidade: 5, precoUnit: 59.9, data: day(10) },
      { id: uid(), produtoId: p2.id, produtoNome: p2.nome, plataforma: "Mercado Livre", quantidade: 1, precoUnit: 199.9, data: day(12) },
    ]);
    setTab("painel");
  };
  const clearAll = () => {
    if (window.confirm("Apagar TODOS os dados (filamentos, produtos, impressoras, vendas) e voltar as configurações ao padrão?")) {
      setFilaments([]); setProducts([]); setPrinters([]); setSales([]); setConfig(DEFAULT_CONFIG); setTab("painel");
    }
  };
  const exportData = () => {
    const blob = new Blob([JSON.stringify({ config, filaments, products, printers, sales }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `camada-backup-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const exportSalesCSV = () => {
    if (sales.length === 0) return;
    const BOM = "\uFEFF";
    let csv = "Data;Produto;Plataforma;Quantidade;Preço Unitário;Faturamento;Custo Unitário;Custo Total;Lucro\r\n";
    sales.forEach((s) => {
      const prod = products.find((p) => p.id === s.produtoId);
      const fil = prod ? filaments.find((f) => f.id === prod.filamentoId) : null;
      const cv = calcVenda(s, prod, fil, config);
      const cUnit = prod ? calcProduto(prod, fil, config).custoTotal : 0;
      const dateFmt = (s.data || "").split("-").reverse().join("/");
      const fmtExcel = (val) => String((val || 0).toFixed(2)).replace(".", ",");
      csv += `${dateFmt};${s.produtoNome};${s.plataforma};${s.quantidade};${fmtExcel(s.precoUnit)};${fmtExcel(cv.receitaBruta)};${fmtExcel(cUnit)};${fmtExcel(cv.custo)};${fmtExcel(cv.lucro)}\r\n`;
    });
    const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `camada-vendas-${todayISO()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const importData = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(reader.result);
        if (typeof d !== "object" || d === null || Array.isArray(d)) throw new Error("formato inválido");
        const ALLOWED_KEYS = new Set(["config", "filaments", "products", "printers", "sales"]);
        for (const k of Object.keys(d)) { if (!ALLOWED_KEYS.has(k)) throw new Error("chave inesperada"); }
        const sanitizeList = (arr, maxLen = 500) => {
          if (!Array.isArray(arr)) return [];
          if (arr.length > maxLen) throw new Error("lista muito grande");
          return arr.filter((item) => typeof item === "object" && item !== null && !Array.isArray(item));
        };
        let cfg = { ...DEFAULT_CONFIG, ...(d.config || {}) };
        if (!Array.isArray(cfg.plataformas)) cfg.plataformas = DEFAULT_CONFIG.plataformas;
        setConfig(cfg);
        setFilaments(sanitizeList(d.filaments));
        setProducts(sanitizeList(d.products));
        setPrinters(sanitizeList(d.printers, 100));
        setSales(sanitizeList(d.sales, 5000));
        setTab("painel");
      } catch (e) { window.alert("Arquivo inválido. Use um backup exportado por este painel."); }
    };
    reader.readAsText(file);
  };

  const tabs = [
    { id: "painel", label: "Painel", icon: LayoutDashboard },
    { id: "impressoras", label: "Impressoras", icon: Printer },
    { id: "filamentos", label: "Filamentos", icon: Boxes },
    { id: "produtos", label: "Produtos", icon: Package },
    { id: "vendas", label: "Vendas", icon: ShoppingCart },
    { id: "config", label: "Configurações", icon: SettingsIcon },
  ];

  if (authLoading) {
    return (
      <div className="ui min-h-screen bed-grid flex flex-col items-center justify-center bg-slate-50" style={{ color: "var(--ink)" }}>
        <style>{CSS}</style>
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center pulse-dot" style={{ background: "var(--accent)" }}>
            <Layers size={24} color="#fff" />
          </div>
          <h2 className="font-display font-bold text-xl text-slate-800">Carregando o Camada...</h2>
          <p className="text-xs text-slate-400">Sincronizando seus dados com a nuvem</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="ui min-h-screen bed-grid flex flex-col items-center justify-center p-4" style={{ color: "var(--ink)" }}>
        <style>{CSS}</style>
        <div className="w-full max-w-md bg-white rounded-2xl shadow-xl overflow-hidden" style={{ border: "1px solid var(--line)" }}>
          <div className="p-6 text-center bg-slate-900 text-white">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-3" style={{ background: "var(--accent)" }}>
              <Layers size={24} color="#fff" />
            </div>
            <h1 className="font-display font-bold text-2xl tracking-tight">Camada</h1>
            <p className="text-xs text-slate-400 mt-1">Gestão inteligente de Impressão 3D</p>
          </div>

          <div className="p-6 space-y-4">
            <div className="flex rounded-lg overflow-hidden" style={{ border: "1px solid var(--line)" }}>
              <button onClick={() => { setAuthMode("login"); setAuthError(""); }} className="flex-1 text-sm py-2 px-3 font-semibold transition" style={{ background: authMode === "login" ? "var(--accent)" : "#fff", color: authMode === "login" ? "#fff" : "var(--muted)" }}>Entrar</button>
              <button onClick={() => { setAuthMode("register"); setAuthError(""); }} className="flex-1 text-sm py-2 px-3 font-semibold transition" style={{ background: authMode === "register" ? "var(--accent)" : "#fff", color: authMode === "register" ? "#fff" : "var(--muted)" }}>Criar Conta</button>
            </div>

            {authError && (
              <div className="p-3 rounded-lg text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-200 flex items-center gap-2">
                <AlertTriangle size={15} />
                <span>{authError}</span>
              </div>
            )}

            <form onSubmit={authMode === "login" ? handleLogin : handleRegister} className="space-y-4">
              <label className="block">
                <span className="block text-xs font-medium text-slate-500 mb-1">E-mail</span>
                <input type="email" required value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} placeholder="exemplo@email.com" className="w-full bg-white px-3 py-2 text-sm rounded-lg outline-none ui" style={{ border: "1px solid var(--line)", color: "var(--ink)" }} />
              </label>

              <label className="block">
                <span className="block text-xs font-medium text-slate-500 mb-1">Senha</span>
                <input type="password" required value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} placeholder="Mínimo 6 caracteres" className="w-full bg-white px-3 py-2 text-sm rounded-lg outline-none ui" style={{ border: "1px solid var(--line)", color: "var(--ink)" }} />
              </label>

              <button type="submit" className="w-full inline-flex items-center justify-center text-sm font-semibold text-white py-2.5 rounded-lg hover:opacity-90 transition" style={{ background: "var(--accent)" }}>
                {authMode === "login" ? "Entrar no Painel" : "Criar Minha Conta"}
              </button>
            </form>

            <div className="relative flex py-1 items-center">
              <div className="flex-grow border-t" style={{ borderColor: "var(--line)" }}></div>
              <span className="flex-shrink mx-4 text-xs text-slate-400">ou</span>
              <div className="flex-grow border-t" style={{ borderColor: "var(--line)" }}></div>
            </div>

            <button type="button" onClick={handleGoogleSignIn} className="w-full inline-flex items-center justify-center gap-2 text-sm font-semibold py-2.5 rounded-lg border hover:bg-slate-50 transition cursor-pointer" style={{ borderColor: "var(--line)", color: "var(--ink)", background: "#fff" }}>
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
              </svg>
              {authMode === "login" ? "Entrar com o Google" : "Cadastrar com o Google"}
            </button>
          </div>
          <div className="p-4 bg-slate-50 text-center text-xs text-slate-400 border-t border-slate-100">
            {authMode === "login" ? "Novo por aqui? Crie sua conta grátis." : "Já tem conta? Faça login acima."}
          </div>
        </div>
      </div>
    );
  }

  if (!isActive) {
    return (
      <PaymentScreen 
        user={user} 
        handleLogout={handleLogout} 
        authError={authError} 
        setAuthError={setAuthError} 
      />
    );
  }

  return (
    <div className="ui min-h-screen bed-grid" style={{ color: "var(--ink)" }}>
      <style>{CSS}</style>

      <header className="sticky top-0 z-30" style={{ background: "#14181F" }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: "var(--accent)" }}><Layers size={20} color="#fff" /></div>
            <div>
              <div className="font-display font-bold text-white leading-none tracking-tight">Camada</div>
              <div className="text-xs text-slate-400 leading-none mt-1">gestão de impressão 3D</div>
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs">
            {!storageOk ? (
              <span className="flex items-center gap-1 text-amber-400"><AlertTriangle size={13} /> erro ao salvar</span>
            ) : savedAt ? (
              <span className="text-slate-400 font-data">salvo na nuvem</span>
            ) : null}
            {expiresAt && (
              <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 font-data">
                Acesso até {expiresAt.toLocaleDateString("pt-BR")}
              </span>
            )}
            <span className="text-slate-300 font-medium truncate max-w-40 hidden sm:inline">{user.email}</span>
            <button onClick={handleLogout} className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-slate-800 transition" title="Sair da conta">
              <LogOut size={16} />
            </button>
          </div>
        </div>
        <div className="layer-edge" />
      </header>

      <nav className="sticky z-20 bg-white" style={{ top: 64, borderBottom: "1px solid var(--line)" }}>
        <div className="max-w-6xl mx-auto px-2 sm:px-6 flex gap-1 overflow-x-auto">
          {tabs.map((t) => {
            const active = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} className="tab-btn flex items-center gap-2 px-3 sm:px-4 py-3 text-sm font-medium whitespace-nowrap" style={{ color: active ? "var(--accent)" : "#64748b", borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent" }}>
                <t.icon size={16} /> {t.label}
              </button>
            );
          })}
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        {tab === "painel" && <Painel filaments={filaments} products={products} printers={printers} sales={sales} config={config} now={now} go={setTab} />}
        {tab === "impressoras" && (
          <Impressoras printers={printers} products={products} config={config} now={now}
            onAdd={() => setPrinterModal({})} onEdit={(pr) => setPrinterModal(pr)} onDelete={delPrinter}
            onStartJob={(pr) => setJobModal(pr)} onFinishJob={finishJob} onCancelJob={cancelJob} onSetStatus={setPrinterStatus} />
        )}
        {tab === "filamentos" && <Filamentos filaments={filaments} onAdd={() => setFilModal({})} onEdit={(f) => setFilModal(f)} onDelete={delFil} />}
        {tab === "produtos" && <Produtos products={products} filaments={filaments} config={config} onAdd={() => setProdModal({})} onEdit={(p) => setProdModal(p)} onDelete={delProd} go={setTab} />}
        {tab === "vendas" && <Vendas sales={sales} products={products} filaments={filaments} config={config} onAdd={() => setSaleModal(true)} onDelete={delSale} go={setTab} onExportCSV={exportSalesCSV} />}
        {tab === "config" && <Configuracoes config={config} setConfig={setConfig} onSeed={seed} onClear={clearAll} onExport={exportData} onImport={importData} />}
      </main>

      {filModal && <FilamentForm initial={filModal.id ? filModal : null} onSave={saveFil} onClose={() => setFilModal(null)} />}
      {prodModal && <ProductForm initial={prodModal.id ? prodModal : null} filaments={filaments} config={config} onSave={saveProd} onClose={() => setProdModal(null)} />}
      {printerModal && <PrinterForm initial={printerModal.id ? printerModal : null} onSave={savePrinter} onClose={() => setPrinterModal(null)} />}
      {jobModal && <JobForm printer={jobModal} products={products} filaments={filaments} config={config} onStart={startJob} onClose={() => setJobModal(null)} />}
      {saleModal && <SaleForm products={products} filaments={filaments} config={config} onSave={saveSale} onClose={() => setSaleModal(false)} />}

      <footer className="max-w-6xl mx-auto px-4 sm:px-6 py-6 text-center text-xs text-slate-400">Camada · seus dados ficam salvos na nuvem</footer>
    </div>
  );
}

function PaymentScreen({ user, handleLogout, authError, setAuthError }) {
  const [preferenceId, setPreferenceId] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchPreference = async () => {
      try {
        setLoading(true);
        setAuthError("");
        const backendUrl = import.meta.env.VITE_API_URL || "http://localhost:3001";
        const res = await fetch(`${backendUrl}/api/create-payment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uid: user.uid, email: user.email })
        });
        if (!res.ok) throw new Error("Erro ao gerar preferência de pagamento.");
        const data = await res.json();
        if (data.id) {
          setPreferenceId(data.id);
        } else {
          throw new Error("Não foi retornado um ID de preferência de pagamento válido.");
        }
      } catch (err) {
        console.error(err);
        setAuthError("Não foi possível gerar o botão de pagamento. Verifique se o servidor backend está ativo.");
      } finally {
        setLoading(false);
      }
    };
    fetchPreference();
  }, [user, setAuthError]);

  return (
    <div className="ui min-h-screen bed-grid flex flex-col items-center justify-center p-4" style={{ color: "var(--ink)" }}>
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl overflow-hidden" style={{ border: "1px solid var(--line)" }}>
        <div className="p-6 text-center bg-slate-900 text-white">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-3" style={{ background: "var(--accent)" }}>
            <Layers size={24} color="#fff" />
          </div>
          <h1 className="font-display font-bold text-2xl tracking-tight">Assinatura Mensal</h1>
          <p className="text-xs text-slate-400 mt-1">Acesso por 30 dias renovável</p>
        </div>

        <div className="p-6 space-y-5">
          <div className="text-center space-y-1">
            <h2 className="text-lg font-display font-semibold" style={{ color: "var(--ink)" }}>Assine o Camada 3D</h2>
            <p className="text-xs text-slate-500">Conclua o pagamento para liberar seu acesso completo por 30 dias.</p>
          </div>

          <div className="p-4 rounded-xl space-y-3" style={{ background: "var(--accent-soft)" }}>
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-semibold" style={{ color: "var(--accent-deep)" }}>Valor da Assinatura</span>
              <span className="font-data font-bold text-xl" style={{ color: "var(--accent-deep)" }}>R$ 22,35 <span className="text-xs font-normal text-slate-500">/mês</span></span>
            </div>
            <div className="text-xs space-y-1.5" style={{ color: "var(--accent-deep)" }}>
              <div className="flex items-center gap-1.5 font-medium">✓ Acesso Completo por 30 dias</div>
              <div className="flex items-center gap-1.5 font-medium">✓ Controle de Impressoras e Filamentos</div>
              <div className="flex items-center gap-1.5 font-medium">✓ Gráficos e Cálculo Automático de Custos</div>
              <div className="flex items-center gap-1.5 font-medium">✓ Sincronização em nuvem segura</div>
            </div>
          </div>

          {authError && (
            <div className="p-3 rounded-lg text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-200 flex items-center gap-2">
              <AlertTriangle size={15} />
              <span>{authError}</span>
            </div>
          )}

          {loading ? (
            <div className="text-center text-xs py-4 text-slate-400 font-semibold pulse-dot">
              Gerando botão de pagamento seguro...
            </div>
          ) : preferenceId ? (
            <div className="w-full">
              <MpWallet initialization={{ preferenceId }} />
            </div>
          ) : (
            <button
              type="button"
              disabled
              className="w-full inline-flex items-center justify-center gap-2 text-sm font-semibold text-white py-3 rounded-lg opacity-50"
              style={{ background: "var(--accent)" }}
            >
              Erro ao carregar checkout
            </button>
          )}
        </div>

        <div className="p-4 bg-slate-50 flex items-center justify-between text-xs text-slate-500 border-t border-slate-100">
          <span>Logado como: <b>{user.email}</b></span>
          <button onClick={handleLogout} className="text-rose-600 font-semibold hover:underline">Sair</button>
        </div>
      </div>
    </div>
  );
}
