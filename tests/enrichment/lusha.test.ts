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

describe("cota diária", () => {
  it("traduz o 429 dizendo que é cota do dia, com o tempo até liberar", async () => {
    // O erro que custou o dia inteiro de cota. "HTTP 429" sozinho parece
    // limite de velocidade — algo que passa em segundos. O da Lusha é diário.
    const fetchFalso = vi.fn(async () =>
      new Response(
        JSON.stringify({
          statusCode: 429,
          message: "Daily API rate limit exceeded. Limit: 100 calls per day. Reset in 7200 seconds.",
        }),
        { status: 429 },
      ),
    );

    await expect(
      buscarNoDominio(
        { dominio: "alfa.com.br", apiKey: "k" },
        { fetch: fetchFalso as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/cota diária/i);

    // E uma chamada só: repetir um limite diário nunca dá certo e consome
    // mais uma da cota que acabou de estourar.
    expect(fetchFalso).toHaveBeenCalledTimes(1);
  });

  it("converte os segundos do reset em horas", async () => {
    const fetchFalso = vi.fn(async () =>
      new Response(
        JSON.stringify({ message: "Daily API rate limit exceeded. Reset in 82810 seconds." }),
        { status: 429 },
      ),
    );

    await expect(
      buscarNoDominio(
        { dominio: "alfa.com.br", apiKey: "k" },
        { fetch: fetchFalso as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/23 h/);
  });
});

describe("formatos reais da V3 nos contatos", () => {
  it("lê o cargo de dentro de jobTitle, que é objeto", async () => {
    // Eu lia como string e recebia null: o lead nasceria sem cargo, e a
    // coluna vazia pareceria "a Lusha não tem" em vez de "eu li errado".
    const { fetchFalso } = servidor(
      { results: [{ id: "v1.x", canReveal: [{ field: "emails", credits: 1 }] }] },
      {
        results: [
          {
            id: "v1.x",
            firstName: "Maria",
            lastName: "Souza",
            jobTitle: {
              title: "Diretora Industrial",
              departments: ["Operations"],
              seniority: "Director",
            },
            emails: [{ address: "maria@alfa.com.br" }],
          },
        ],
      },
    );

    const achados = await buscarNoDominio(
      { dominio: "alfa.com.br", cargos: ["Diretor Industrial"], apiKey: "k" },
      { fetch: fetchFalso },
    );

    expect(achados[0]?.cargo).toBe("Diretora Industrial");
    expect(achados[0]?.nome).toBe("Maria Souza");
  });

  it("não enriquece contato que não tem e-mail para revelar", async () => {
    // O enriquecimento cobra por e-mail revelado. Mandar quem não tem gasta a
    // chamada e devolve nada.
    const { fetchFalso, chamadas } = servidor({
      results: [{ id: "v1.semEmail", canReveal: [{ field: "phones", credits: 1 }] }],
    });

    const achados = await buscarNoDominio(
      { dominio: "alfa.com.br", apiKey: "k" },
      { fetch: fetchFalso },
    );

    expect(achados).toEqual([]);
    // Uma chamada só: a busca. O enrich nem foi tentado.
    expect(chamadas).toHaveLength(1);
  });

  it("deixa passar quando a resposta não traz canReveal nem has", async () => {
    // Ausência do sinal não é um "não". Recusar por falta de informação
    // transformaria formato inesperado em "empresa sem decisor".
    const { fetchFalso, chamadas } = servidor(
      { results: [{ id: "v1.y" }] },
      { results: [{ id: "v1.y", email: "alguem@alfa.com.br" }] },
    );

    const achados = await buscarNoDominio(
      { dominio: "alfa.com.br", apiKey: "k" },
      { fetch: fetchFalso },
    );

    expect(achados).toHaveLength(1);
    expect(chamadas).toHaveLength(2);
  });
});

describe("segunda busca sem filtro de cargo", () => {
  it("tenta de novo sem cargo quando a primeira volta vazia", async () => {
    // "Nenhum contato" tem duas causas que a mesma resposta não distingue: a
    // Lusha não tem ninguém da empresa, ou tem e os cargos em português não
    // casaram com o índice dela. Sem esta segunda busca, as duas viram
    // "vazio" e a conclusão errada é "a Lusha não cobre empresa brasileira".
    const chamadas: any[] = [];
    let n = 0;
    const fetchFalso = vi.fn(async (_url: unknown, init?: RequestInit) => {
      n += 1;
      chamadas.push(init?.body ? JSON.parse(String(init.body)) : null);
      if (n === 1) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      if (n === 2) {
        return new Response(
          JSON.stringify({ results: [{ id: "v1.z", canReveal: [{ field: "emails" }] }] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          results: [{ id: "v1.z", firstName: "Ana", email: "ana@alfa.com.br" }],
        }),
        { status: 200 },
      );
    });

    const achados = await buscarNoDominio(
      { dominio: "alfa.com.br", cargos: ["Diretor de Operações"], apiKey: "k" },
      { fetch: fetchFalso as unknown as typeof fetch },
    );

    expect(achados).toHaveLength(1);
    // A primeira busca leva o cargo; a segunda não.
    expect(chamadas[0].filters.contacts.include.jobTitles).toEqual([
      "Diretor de Operações",
    ]);
    expect(chamadas[1].filters.contacts).toBeUndefined();
    // Confiança rebaixada: é da empresa certa, mas o cargo não foi filtrado.
    expect(achados[0]?.confianca).toBeLessThanOrEqual(55);
  });

  it("não faz a segunda busca quando a primeira já achou", async () => {
    const { fetchFalso, chamadas } = servidor(
      { results: [{ id: "v1.a", canReveal: [{ field: "emails" }] }] },
      { results: [{ id: "v1.a", email: "a@alfa.com.br", jobTitle: { title: "Diretor" } }] },
    );

    const achados = await buscarNoDominio(
      { dominio: "alfa.com.br", cargos: ["Diretor"], apiKey: "k" },
      { fetch: fetchFalso },
    );

    expect(achados).toHaveLength(1);
    // Busca + enriquecimento. Sem terceira chamada.
    expect(chamadas).toHaveLength(2);
    expect(achados[0]?.confianca).toBeGreaterThan(55);
  });

  it("sem cargo pedido, não repete a busca à toa", async () => {
    const { fetchFalso, chamadas } = servidor({ results: [] });

    await buscarNoDominio({ dominio: "alfa.com.br", apiKey: "k" }, { fetch: fetchFalso });

    expect(chamadas).toHaveLength(1);
  });
});

describe("o id da empresa é o localizador exato", () => {
  it("usa `ids` quando a empresa veio da própria Lusha", async () => {
    // A empresa foi descoberta no grafo dela e traz um id. Pedir os contatos
    // por domínio nesse caso é fazer a base reconhecer de novo algo que ela
    // mesma acabou de entregar — o passo onde Receita e Lusha já falharam em
    // se casar.
    const { fetchFalso, chamadas } = servidor({ results: [] });

    await buscarNoDominio(
      {
        idExterno: "v1.company.abc",
        dominio: "alfa.com.br",
        empresa: "Alfa Alimentos",
        apiKey: "k",
      },
      { fetch: fetchFalso },
    );

    const empresas = chamadas[0]?.corpo.filters.companies.include;
    expect(empresas.ids).toEqual(["v1.company.abc"]);
    // Id exato dispensa os outros: mandar junto só estreitaria a busca.
    expect(empresas.domains).toBeUndefined();
    expect(empresas.names).toBeUndefined();
  });

  it("cai para domínio quando não há id", async () => {
    const { fetchFalso, chamadas } = servidor({ results: [] });

    await buscarNoDominio(
      { dominio: "alfa.com.br", empresa: "Alfa", apiKey: "k" },
      { fetch: fetchFalso },
    );

    expect(chamadas[0]?.corpo.filters.companies.include.domains).toEqual([
      "alfa.com.br",
    ]);
  });
});
