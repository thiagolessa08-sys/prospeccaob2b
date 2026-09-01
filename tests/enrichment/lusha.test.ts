import { describe, it, expect, vi } from "vitest";
import { acharEmailPorNome, buscarNoDominio, verificarEmail } from "../../src/enrichment/lusha.js";

/**
 * O contrato da Lusha não foi verificado ao vivo — a documentação é uma SPA e
 * não entrega os schemas. Estes testes fixam o que o adaptador PROMETE fazer
 * com a resposta, não o que a Lusha realmente responde: que ele aceita mais de
 * um nome plausível por campo, que faz as duas etapas, e sobretudo que ele
 * **falha alto** quando não reconhece nada, em vez de devolver lista vazia.
 *
 * Essa última é a que mais importa. Lista vazia é indistinguível de "empresa
 * sem decisor", e o funil marcaria a empresa como `failed` em silêncio — a
 * chave errada, o filtro errado e o campo renomeado ficariam todos parecendo
 * "não achamos ninguém".
 */
function respostas(...corpos: unknown[]) {
  const chamadas: Array<{ url: string; corpo: unknown }> = [];
  let i = 0;
  const fetchFalso = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({
      url: String(url),
      corpo: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const corpo = corpos[Math.min(i++, corpos.length - 1)];
    return new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchFalso: fetchFalso as unknown as typeof fetch, chamadas };
}

const BUSCA_OK = { requestId: "req-1", results: [{ id: "c1" }] };

describe("acharEmailPorNome (Lusha)", () => {
  it("busca e depois enriquece, mandando o requestId adiante", async () => {
    const { fetchFalso, chamadas } = respostas(BUSCA_OK, {
      results: [
        {
          id: "c1",
          firstName: "Maria",
          lastName: "Souza",
          jobTitle: "Diretora Industrial",
          email: "maria@alfa.com.br",
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

    expect(chamadas).toHaveLength(2);
    expect(chamadas[0]?.url).toContain("/prospecting/contact/search");
    expect(chamadas[1]?.url).toContain("/prospecting/contact/enrich");
    expect(chamadas[1]?.corpo).toMatchObject({ requestId: "req-1", contactIds: ["c1"] });
  });

  it("manda a chave no header api_key", async () => {
    const chamadas: RequestInit[] = [];
    const fetchFalso = vi.fn(async (_url: unknown, init?: RequestInit) => {
      chamadas.push(init ?? {});
      return new Response(JSON.stringify(BUSCA_OK), { status: 200 });
    });

    await acharEmailPorNome(
      { dominio: "alfa.com.br", primeiroNome: "M", sobrenome: "S", apiKey: "chave-secreta" },
      { fetch: fetchFalso as unknown as typeof fetch },
    ).catch(() => {});

    const headers = chamadas[0]?.headers as Record<string, string>;
    expect(headers.api_key).toBe("chave-secreta");
  });

  it("aceita os outros nomes plausíveis de campo", async () => {
    const { fetchFalso } = respostas(
      { requestId: "r", data: [{ contactId: "c9" }] },
      { contacts: [{ full_name: "João Lima", title: "CTO", email_address: "joao@beta.com" }] },
    );

    const achado = await acharEmailPorNome(
      { dominio: "beta.com", primeiroNome: "João", sobrenome: "Lima", apiKey: "k" },
      { fetch: fetchFalso },
    );

    expect(achado?.email).toBe("joao@beta.com");
    expect(achado?.nome).toBe("João Lima");
    expect(achado?.cargo).toBe("CTO");
  });

  it("devolve null quando a busca não encontra ninguém", async () => {
    // Sem resultado na BUSCA é resposta legítima: a empresa não tem contato
    // no acervo. Diferente de não entender a resposta.
    const { fetchFalso } = respostas({ requestId: "r", results: [] });

    const achado = await acharEmailPorNome(
      { dominio: "vazia.com", primeiroNome: "A", sobrenome: "B", apiKey: "k" },
      { fetch: fetchFalso },
    );
    expect(achado).toBeNull();
  });

  it("lança quando acha contatos mas não reconhece identificador", async () => {
    const { fetchFalso } = respostas({ results: [{ nome_estranho: "x" }] });

    await expect(
      acharEmailPorNome(
        { dominio: "alfa.com.br", primeiroNome: "A", sobrenome: "B", apiKey: "k" },
        { fetch: fetchFalso },
      ),
    ).rejects.toThrow(/identificador/i);
  });

  it("lança quando o enriquecimento devolve forma irreconhecível", async () => {
    const { fetchFalso } = respostas(BUSCA_OK, { algo: "inesperado" });

    await expect(
      acharEmailPorNome(
        { dominio: "alfa.com.br", primeiroNome: "A", sobrenome: "B", apiKey: "k" },
        { fetch: fetchFalso },
      ),
    ).rejects.toThrow(/Forma recebida/);
  });

  it("não chama a API sem domínio nem nome de empresa", async () => {
    const { fetchFalso, chamadas } = respostas(BUSCA_OK);
    const achado = await acharEmailPorNome(
      { primeiroNome: "A", sobrenome: "B", apiKey: "k" },
      { fetch: fetchFalso },
    );
    expect(achado).toBeNull();
    expect(chamadas).toHaveLength(0);
  });
});

describe("buscarNoDominio (Lusha)", () => {
  it("leva cargo e senioridade como filtro de contato", async () => {
    const { fetchFalso, chamadas } = respostas(BUSCA_OK, {
      results: [{ email: "ti@alfa.com.br", jobTitle: "Gerente de TI", confidence: 88 }],
    });

    const achados = await buscarNoDominio(
      {
        dominio: "alfa.com.br",
        departamento: "Gerente de TI",
        senioridade: "manager",
        apiKey: "k",
      },
      { fetch: fetchFalso },
    );

    expect(achados).toHaveLength(1);
    expect(achados[0]?.confianca).toBe(88);
    expect(achados[0]?.fonte).toBe("lusha_domain");
    expect(chamadas[0]?.corpo).toMatchObject({
      filters: { contacts: { include: { jobTitles: ["Gerente de TI"], seniority: ["manager"] } } },
    });
  });

  it("descarta contato sem e-mail em vez de inventar um", async () => {
    const { fetchFalso } = respostas(BUSCA_OK, {
      results: [{ id: "c1", firstName: "Sem", lastName: "Email" }],
    });

    const achados = await buscarNoDominio(
      { dominio: "alfa.com.br", apiKey: "k" },
      { fetch: fetchFalso },
    );
    expect(achados).toEqual([]);
  });

  it("sem sinal de status, marca accept_all — indeterminado, não reprovado", async () => {
    const { fetchFalso } = respostas(BUSCA_OK, {
      results: [{ email: "alguem@alfa.com.br" }],
    });

    const achados = await buscarNoDominio(
      { dominio: "alfa.com.br", apiKey: "k" },
      { fetch: fetchFalso },
    );
    expect(achados[0]?.verificacao).toBe("accept_all");
    expect(achados[0]?.confianca).toBe(75);
  });
});

describe("verificarEmail (Lusha)", () => {
  it("devolve unknown, que a cadeia não aprova", async () => {
    // A Lusha não verifica endereço avulso. `unknown` faz a cadeia recusar o
    // e-mail declarado à Receita em vez de enviá-lo sem conferência.
    expect(await verificarEmail()).toEqual({ status: "unknown", score: 0 });
  });
});
