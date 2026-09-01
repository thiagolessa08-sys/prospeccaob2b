import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subirBanco, type BancoDeTeste } from "../../helpers/pg.js";
import { criarApp } from "../../../src/api/server.js";
import { COOKIE_DO_PAINEL } from "../../../src/api/sessao-painel.js";

let banco: BancoDeTeste;

beforeAll(async () => {
  banco = await subirBanco();
}, 30_000);

afterAll(async () => {
  await banco.encerrar();
});

const SENHA = "senha-longa-do-operador";
const SEGREDO_N8N = "segredo-n8n";

function app(senhaDoPainel = SENHA) {
  return criarApp({
    db: banco.db,
    tenantId: banco.tenantId,
    segredoInstantly: "segredo-instantly",
    segredoCalcom: "segredo-calcom",
    segredoN8n: SEGREDO_N8N,
    senhaDoPainel,
    apiKeyHunter: "chave-hunter",
    apiKeyLusha: "",
    loteDeDescoberta: 300,
    loteDeEnriquecimento: 20,
    apiKeyCasaDosDados: "chave-casa-dos-dados",
  });
}

/** Faz login e devolve o cookie pronto para reenviar. */
async function entrar(senha = SENHA): Promise<string> {
  const res = await app().request("/painel/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ senha }),
  });
  expect(res.status).toBe(200);

  const set = res.headers.get("set-cookie");
  expect(set).toBeTruthy();
  return set!.split(";")[0]!;
}

describe("POST /painel/login", () => {
  it("devolve 503 quando PAINEL_SENHA não está configurada", async () => {
    // 503 e não 401 de propósito: 401 mandaria o operador procurar a senha
    // certa, quando nenhuma senha vai funcionar até alguém configurar.
    const res = await app("").request("/painel/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ senha: "qualquer" }),
    });
    expect(res.status).toBe(503);
  });

  it("recusa senha errada", async () => {
    const res = await app().request("/painel/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ senha: "senha-errada" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("recusa corpo que não é JSON", async () => {
    const res = await app().request("/painel/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "isto não é json",
    });
    expect(res.status).toBe(400);
  });

  it("emite o cookie de sessão na senha certa", async () => {
    const res = await app().request("/painel/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ senha: SENHA }),
    });
    expect(res.status).toBe(200);

    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toContain(COOKIE_DO_PAINEL + "=");
    expect(set).toContain("HttpOnly");
  });
});

describe("POST /painel/sair", () => {
  it("apaga o cookie", async () => {
    const res = await app().request("/painel/sair", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });
});

describe("a sessão autoriza as rotas do painel", () => {
  it("recusa sem cookie e sem header", async () => {
    const res = await app().request("/painel/campanhas");
    expect(res.status).toBe(401);
  });

  it("aceita com o cookie da sessão", async () => {
    const cookie = await entrar();
    const res = await app().request("/painel/campanhas", { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it("recusa cookie assinado com outra senha", async () => {
    // O app do login usa SENHA; este confere contra outra. O cookie é
    // legítimo, mas não para este servidor.
    const cookie = await entrar();
    const res = await app("outra-senha").request("/painel/campanhas", {
      headers: { cookie },
    });
    expect(res.status).toBe(401);
  });

  it("continua aceitando o header do n8n, que não tem cookie", async () => {
    const res = await app().request("/painel/campanhas", {
      headers: { "x-prospeccao-segredo": SEGREDO_N8N },
    });
    expect(res.status).toBe(200);
  });
});

describe("a sessão autoriza as rotas de lote, que a tela dispara", () => {
  it("cria campanha pelo cookie, com o corpo chegando inteiro ao handler", async () => {
    // O caso que prova a ponte: `comoOperador` reconstrói a requisição para
    // injetar o header, e reconstruir errado perderia o corpo — o handler
    // responderia 400 por campo ausente em vez de 201.
    const cookie = await entrar();
    const res = await app().request("/campaigns", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Criada pelo painel",
        nicheDescription: "indústrias de alimentos em SC",
        offerDescription: "BI",
        schedulingLink: "https://cal.com/t/30min",
        senderFirstName: "Thiago",
      }),
    });

    expect(res.status).toBe(201);
    const corpo = (await res.json()) as { id: string; name: string };
    expect(corpo.name).toBe("Criada pelo painel");
  });

  it("recusa a mesma criação sem cookie", async () => {
    const res = await app().request("/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Sem sessão",
        nicheDescription: "indústrias",
        offerDescription: "BI",
        schedulingLink: "https://cal.com/t/30min",
        senderFirstName: "Thiago",
      }),
    });
    expect(res.status).toBe(401);
  });
});
