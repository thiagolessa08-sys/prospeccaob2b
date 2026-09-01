import { describe, it, expect, vi } from "vitest";
import {
  acharEmailPorNome,
  buscarNoDominio,
  verificarEmail,
} from "../../src/enrichment/lusha.js";

/**
 * Os endpoints, o header e o fluxo vêm da documentação da API V3 da Lusha. O
 * que continua sem confirmação ao vivo são os nomes dos campos da resposta —
 * a doc descreve o que cada endpoint devolve, não o schema.
 *
 * Estes testes fixam o que o adaptador promete: que chama o caminho certo,
 * que traduz os erros com significado de negócio, e sobretudo que **falha
 * alto** quando não reconhece a resposta, em vez de devolver lista vazia.
 * Essa última é a que mais importa — lista vazia é indistinguível de "empresa
 * sem decisor", e chave errada, filtro errado e campo renomeado ficariam
 * todos parecendo "não achamos ninguém".
 */
function servidor(...corpos: unknown[]) {
  const chamadas: Array<{
    url: string;
    corpo: Record<string, any>;
    headers: Record<string, string>;
  }> = [];
  let i = 0;
  const fetchFalso = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({
      url: String(url),
      corpo: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(corpoDaVez(corpos, i++)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchFalso: fetchFalso as unknown as typeof fetch, chamadas };
}

function corpoDaVez(corpos: unknown[], i: number): unknown {
  return corpos[Math.min(i, corpos.length - 1)];
}

/** Servidor que responde com um status de erro. */
function servidorComErro(status: number) {
  const fetchFalso = vi.fn(async () =>
    new Response(JSON.stringify({ statusCode: status, message: "erro" }), { status }),
  );
  return fetchFalso as unknown as typeof fetch;
}

describe("acharEmailPorNome (Lusha)", () => {
  it("resolve em uma chamada a search-and-enrich", async () => {
    const { fetchFalso, chamadas } = servidor({
      data: [
        {
          id: "v1.abc",
          firstName: "Maria",
          lastName: "Souza",
          jobTitle: "Diretora Industrial",
          emails: [{ address: "maria@alfa.com.br" }],
          emailStatus: "valid",
        },
      ],
    });

    const achado = await acharEmailPorNome(
      {
        dominio: "alfa.com.br",
        primeiroNome: "Maria",
        sobrenome: "Souza",
        apiKey: "chave",
      },
      { fetch: fetchFalso },
    );

    expect(achado?.email).toBe("maria@alfa.com.br");
    expect(achado?.cargo).toBe("Diretora Industrial");
    expect(achado?.verificacao).toBe("valid");
    expect(achado?.fonte).toBe("lusha_finder");

    // Uma chamada só, no caminho da V3.
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.url).toBe(
      "https://api.lusha.com/v3/contacts/search-and-enrich",
    );
    expect(chamadas[0]?.headers.api_key).toBe("chave");
    expect(chamadas[0]?.corpo.contacts[0]).toMatchObject({
      firstName: "Maria",
      lastName: "Souza",
      companyDomain: "alfa.com.br",
    });
    // Telefone é outro crédito, e o funil é todo de e-mail.
    expect(chamadas[0]?.corpo.reveal).toEqual(["emails"]);
  });

  it("usa o nome da empresa quando não há domínio", async () => {
    const { fetchFalso, chamadas } = servidor({ data: [] });

    await acharEmailPorNome(
      { empresa: "Alfa Ltda", primeiroNome: "A", sobrenome: "B", apiKey: "k" },
      { fetch: fetchFalso },
    );

    expect(chamadas[0]?.corpo.contacts[0].companyName).toBe("Alfa Ltda");
    expect(chamadas[0]?.corpo.contacts[0].companyDomain).toBeUndefined();
  });

  it("não chama a API sem domínio nem nome de empresa", async () => {
    const { fetchFalso, chamadas } = servidor({ data: [] });
    const achado = await acharEmailPorNome(
      { primeiroNome: "A", sobrenome: "B", apiKey: "k" },
      { fetch: fetchFalso },
    );
    expect(achado).toBeNull();
    expect(chamadas).toHaveLength(0);
  });

  it("devolve null quando não acha ninguém", async () => {
    const { fetchFalso } = servidor({ data: [] });
    const achado = await acharEmailPorNome(
      { dominio: "vazia.com", primeiroNome: "A", sobrenome: "B", apiKey: "k" },
      { fetch: fetchFalso },
    );
    expect(achado).toBeNull();
  });

  it("trata 451 (GDPR) como contato indisponível, não como falha", async () => {
    // A Lusha achou a pessoa e a lei impede de entregá-la. Tratar como erro
    // encheria `events` de falhas que ninguém pode consertar.
    const achado = await acharEmailPorNome(
      { dominio: "alfa.com.br", primeiroNome: "A", sobrenome: "B", apiKey: "k" },
      { fetch: servidorComErro(451) },
    );
    expect(achado).toBeNull();
  });

  it("diz que faltou crédito quando devolve 402", async () => {
    // Sem esta tradução o operador lê "HTTP 402" e procura defeito no código
    // em vez de recarregar a conta.
    await expect(
      acharEmailPorNome(
        { dominio: "alfa.com.br", primeiroNome: "A", sobrenome: "B", apiKey: "k" },
        { fetch: servidorComErro(402) },
      ),
    ).rejects.toThrow(/crédito/i);
  });

  it("deixa 401 subir como veio — chave errada não é caso de negócio", async () => {
    await expect(
      acharEmailPorNome(
        { dominio: "alfa.com.br", primeiroNome: "A", sobrenome: "B", apiKey: "errada" },
        { fetch: servidorComErro(401) },
      ),
    ).rejects.toThrow(/401/);
  });
});

describe("buscarNoDominio (Lusha)", () => {
  it("faz prospecting e depois enrich, nos caminhos da V3", async () => {
    const { fetchFalso, chamadas } = servidor(
      { data: [{ id: "v1.xyz" }] },
      { data: [{ id: "v1.xyz", email: "ti@alfa.com.br", jobTitle: "Gerente de TI", confidence: 88 }] },
    );

    const achados = await buscarNoDominio(
      {
        dominio: "alfa.com.br",
        departamento: "it",
        cargos: ["Gerente de TI"],
        senioridade: "manager",
        apiKey: "k",
      },
      { fetch: fetchFalso },
    );

    expect(achados).toHaveLength(1);
    expect(achados[0]?.confianca).toBe(88);
    expect(achados[0]?.fonte).toBe("lusha_domain");

    expect(chamadas[0]?.url).toBe("https://api.lusha.com/v3/contacts/prospecting");
    expect(chamadas[1]?.url).toBe("https://api.lusha.com/v3/contacts/enrich");
    expect(chamadas[1]?.corpo).toMatchObject({
      contactIds: ["v1.xyz"],
      reveal: ["emails"],
    });
  });

  it("filtra por jobTitles vindos dos cargos, e nunca pela sigla da Hunter", async () => {
    // `departamento` e o vocabulario da Hunter (`finance`), derivado dos
    // cargos por `alvoDaCampanha`. Mandar isso como titulo procura por alguem
    // chamado "finance" — e o vazio resultante se disfarcaria de "a Lusha nao
    // tem contato nesta empresa".
    const { fetchFalso, chamadas } = servidor({ data: [] });

    await buscarNoDominio(
      {
        dominio: "alfa.com.br",
        departamento: "finance",
        cargos: ["Diretor de Operações", "Gerente de Controladoria"],
        apiKey: "k",
      },
      { fetch: fetchFalso },
    );

    const filtros = chamadas[0]?.corpo.filters;
    expect(filtros.contacts.include.jobTitles).toEqual([
      "Diretor de Operações",
      "Gerente de Controladoria",
    ]);
    expect(JSON.stringify(filtros)).not.toContain("finance");
    expect(filtros.contacts.include.departments).toBeUndefined();
    expect(filtros.companies.include.domains).toEqual(["alfa.com.br"]);
  });

  it("sem cargos, busca a empresa inteira em vez de filtrar por nada", async () => {
    const { fetchFalso, chamadas } = servidor({ data: [] });

    await buscarNoDominio(
      { dominio: "alfa.com.br", departamento: "finance", apiKey: "k" },
      { fetch: fetchFalso },
    );

    expect(chamadas[0]?.corpo.filters.contacts).toBeUndefined();
  });


  it("não enriquece quando a busca não devolve ninguém", async () => {
    // O enrich é a etapa que cobra. Chamá-lo com lista vazia seria gastar
    // chamada à toa.
    const { fetchFalso, chamadas } = servidor({ data: [] });

    const achados = await buscarNoDominio(
      { dominio: "vazia.com", apiKey: "k" },
      { fetch: fetchFalso },
    );

    expect(achados).toEqual([]);
    expect(chamadas).toHaveLength(1);
  });

  it("lança quando acha contatos mas não reconhece identificador", async () => {
    const { fetchFalso } = servidor({ data: [{ nome_estranho: "x" }] });

    await expect(
      buscarNoDominio({ dominio: "alfa.com.br", apiKey: "k" }, { fetch: fetchFalso }),
    ).rejects.toThrow(/identificador/i);
  });

  it("lança quando o enriquecimento devolve forma irreconhecível", async () => {
    const { fetchFalso } = servidor({ data: [{ id: "v1.x" }] }, { algo: "inesperado" });

    await expect(
      buscarNoDominio({ dominio: "alfa.com.br", apiKey: "k" }, { fetch: fetchFalso }),
    ).rejects.toThrow(/Forma recebida/);
  });

  it("descarta contato sem e-mail em vez de inventar um", async () => {
    const { fetchFalso } = servidor(
      { data: [{ id: "v1.x" }] },
      { data: [{ id: "v1.x", firstName: "Sem", lastName: "Email" }] },
    );

    const achados = await buscarNoDominio(
      { dominio: "alfa.com.br", apiKey: "k" },
      { fetch: fetchFalso },
    );
    expect(achados).toEqual([]);
  });

  it("sem sinal de status, marca accept_all — indeterminado, não reprovado", async () => {
    const { fetchFalso } = servidor(
      { data: [{ id: "v1.x" }] },
      { data: [{ id: "v1.x", email: "alguem@alfa.com.br" }] },
    );

    const achados = await buscarNoDominio(
      { dominio: "alfa.com.br", apiKey: "k" },
      { fetch: fetchFalso },
    );
    expect(achados[0]?.verificacao).toBe("accept_all");
    expect(achados[0]?.confianca).toBe(75);
  });

  it("451 no enrich devolve vazio, sem derrubar o lote", async () => {
    let chamada = 0;
    const fetchFalso = vi.fn(async () => {
      chamada += 1;
      if (chamada === 1) {
        return new Response(JSON.stringify({ data: [{ id: "v1.x" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ statusCode: 451 }), { status: 451 });
    });

    const achados = await buscarNoDominio(
      { dominio: "alfa.com.br", apiKey: "k" },
      { fetch: fetchFalso as unknown as typeof fetch },
    );
    expect(achados).toEqual([]);
  });
});

describe("verificarEmail (Lusha)", () => {
  it("devolve unknown, que a cadeia não aprova", async () => {
    // A Lusha não verifica endereço avulso. `unknown` faz a cadeia recusar o
    // e-mail declarado à Receita em vez de enviá-lo sem conferência.
    expect(await verificarEmail()).toEqual({ status: "unknown", score: 0 });
  });
});
