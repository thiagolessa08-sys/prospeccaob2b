import { fetchJson, HttpError, type FetchLike } from "../http/fetch-json.js";
import type { CandidatoDecisor, StatusVerificacao } from "./types.js";

/**
 * Adaptador da Lusha (API V3), no lugar da Hunter para achar o decisor.
 *
 * Com `LUSHA_API_KEY` preenchida, a descoberta de empresas também é dela
 * (`discovery/lusha-empresas.ts`) — e é o que faz esta busca de contato
 * funcionar, porque a empresa passa a vir do grafo dela, com domínio.
 *
 * Dois caminhos, espelhando o que a cadeia já pedia da Hunter:
 *
 * - achar uma pessoa conhecida → `/contacts/search-and-enrich`, que aceita
 *   `firstName` + `lastName` + `companyDomain` como identificador e revela o
 *   e-mail na mesma chamada. É o equivalente do email-finder.
 * - achar quem tem o cargo → `/contacts/prospecting` (filtro por cargo,
 *   senioridade e domínio da empresa) e depois `/contacts/enrich` com os ids.
 *   É o equivalente do domain-search.
 *
 * A busca por filtro devolve prévia sem PII: e-mail só sai do enriquecimento,
 * e é lá que o crédito de `revealEmail` é consumido. Fazer as duas etapas aqui
 * dentro mantém a cadeia sem saber disso — para ela, isto é "ache o decisor".
 *
 * O que continua não verificado ao vivo são os NOMES DOS CAMPOS da resposta:
 * a documentação descreve o que cada endpoint devolve, não o schema exato.
 * Por isso a leitura aceita mais de um nome plausível por campo e, quando não
 * reconhece nada, lança com um resumo da forma recebida em vez de devolver
 * lista vazia — lista vazia é indistinguível de "empresa sem decisor".
 */
const BASE = "https://api.lusha.com/v3";

/**
 * Quantos contatos pedir por empresa.
 *
 * UM, na fase de teste. A cota da Lusha é diária e baixa (100 no plano
 * base), e cada contato revelado é uma cobrança. Pedir dez para escolher um
 * gasta dez vezes mais para o mesmo lead — faz sentido quando se está
 * calibrando qualidade, não quando se está calibrando se a integração
 * funciona.
 */
const POR_EMPRESA = 1;

/**
 * O mínimo que a API aceita em `pagination.size`.
 *
 * Ela recusa menos que isso com "pagination.size must not be less than 10".
 * Então pedir "só um contato" não se faz encolhendo a página: pede-se a
 * página mínima e limita-se o resto — `maxContactsPerCompany` na busca, e um
 * corte na lista de ids antes do enriquecimento, que é a etapa que cobra por
 * e-mail revelado.
 */
const PAGINA_MINIMA = 10;

/**
 * Só o e-mail é revelado. Telefone é outro crédito por contato, e o funil
 * inteiro é de e-mail — não há para onde discar.
 */
const REVELAR = ["emails"];

interface Chamada {
  apiKey: string;
  fetch?: FetchLike;
}

async function postar<T>(
  caminho: string,
  corpo: unknown,
  { apiKey, fetch: fetchLike }: Chamada,
): Promise<T> {
  return fetchJson<T>(`${BASE}${caminho}`, {
    fetch: fetchLike,
    metodo: "POST",
    headers: { api_key: apiKey, "content-type": "application/json" },
    corpo: JSON.stringify(corpo),
    /**
     * UMA tentativa. Sem repetição.
     *
     * O padrão do `fetchJson` repete 429, o que faz sentido para limite por
     * segundo — espera e passa. O limite da Lusha é DIÁRIO: 100 chamadas, com
     * reset em até 24 h. Repetir ali não tem como dar certo, e cada repetição
     * consome mais uma da cota que acabou de estourar.
     *
     * Foi o que aconteceu: 60 empresas × 2 chamadas já encostavam no teto, e
     * o retry triplicou cada 429 até queimar o dia inteiro — com a tela
     * dizendo "nenhum decisor encontrado".
     */
    tentativas: 1,
  });
}

/** Sem crédito. Merece mensagem própria — some no meio de um 4xx genérico. */
const SEM_CREDITO = 402;
/** Contato bloqueado por GDPR. Não é falha nossa nem da chave. */
const BLOQUEADO_POR_LEI = 451;
/** Cota estourada. Na Lusha é DIÁRIA, não por segundo. */
const COTA_ESTOURADA = 429;

/** "Reset in 82810 seconds" → "23 h". O número cru não diz nada a ninguém. */
function quandoVolta(corpo: string): string {
  const achado = /Reset in (\d+) seconds/i.exec(corpo);
  if (!achado) return "";
  const horas = Math.round(Number(achado[1]) / 3600);
  return horas > 0 ? ` Libera em cerca de ${horas} h.` : " Libera em menos de 1 h.";
}

/**
 * Traduz os erros que têm significado de negócio.
 *
 * `451` vira lista vazia: a Lusha achou a pessoa e a lei impede de entregá-la.
 * Isso é "não temos este contato", não "a integração quebrou" — tratar como
 * erro encheria `events` de falhas que ninguém pode consertar.
 *
 * `402` continua sendo erro, mas com o texto certo: sem esta tradução, o
 * operador leria `HTTP 402` e iria procurar defeito no código em vez de
 * comprar crédito.
 */
function traduzirErro(erro: unknown): never | [] {
  if (erro instanceof HttpError && erro.status === BLOQUEADO_POR_LEI) return [];

  if (erro instanceof HttpError && erro.status === SEM_CREDITO) {
    throw new Error(
      "Lusha recusou por falta de crédito (HTTP 402). O enriquecimento para até a conta ser recarregada.",
    );
  }

  if (erro instanceof HttpError && erro.status === COTA_ESTOURADA) {
    /**
     * Limite DIÁRIO de chamadas, não de velocidade. Merece a tradução mais
     * clara das três, porque é o único que não se resolve mexendo em nada:
     * não é chave, não é crédito, não é código — é esperar.
     */
    throw new Error(
      `Lusha: cota diária de chamadas esgotada (HTTP 429).${quandoVolta(erro.corpo)} ` +
        "Cada empresa consome 2 chamadas (buscar + revelar), então um lote de 20 usa 40.",
    );
  }

  throw erro;
}

/**
 * Lê um campo aceitando mais de um nome.
 *
 * Não é preguiça: sem o schema confirmado, fixar um nome só faria o
 * adaptador devolver "nada encontrado" — indistinguível de uma empresa sem
 * decisor — no dia em que o campo se chamasse `email_address` em vez de
 * `email`. Errar o nome do campo tem que parecer erro, não resultado vazio.
 */
function texto(obj: Record<string, unknown>, ...nomes: string[]): string | null {
  for (const nome of nomes) {
    const valor = obj[nome];
    if (typeof valor === "string" && valor.trim().length > 0) return valor.trim();
  }
  return null;
}

function numero(obj: Record<string, unknown>, ...nomes: string[]): number | null {
  for (const nome of nomes) {
    const valor = obj[nome];
    if (typeof valor === "number" && Number.isFinite(valor)) return valor;
  }
  return null;
}

function objetos(valor: unknown): Record<string, unknown>[] {
  if (!Array.isArray(valor)) return [];
  return valor.filter(
    (i): i is Record<string, unknown> => typeof i === "object" && i !== null,
  );
}

/** A lista de resultados, sob qualquer um dos nomes que a doc menciona. */
function listaDeResultados(resposta: unknown): Record<string, unknown>[] {
  if (typeof resposta !== "object" || resposta === null) return [];
  const r = resposta as Record<string, unknown>;
  // `results` é o nome documentado da V3. Os outros ficam por segurança.
  for (const nome of ["results", "data", "contacts"]) {
    const lista = objetos(r[nome]);
    if (lista.length > 0) return lista;
  }
  return [];
}

function formaRecebida(resposta: unknown): string {
  if (typeof resposta !== "object" || resposta === null) return typeof resposta;
  return Object.keys(resposta as Record<string, unknown>).join(", ") || "{}";
}

/**
 * Do que a Lusha diz sobre o e-mail para o nosso vocabulário.
 *
 * Sem sinal reconhecível, `accept_all` — que na cadeia significa
 * "indeterminado, não reprovado", e é exatamente o que sabemos: a Lusha
 * entregou o endereço, não afirmou que ele é válido. Marcar `valid` seria
 * afirmar por ela; marcar `invalid` descartaria contato bom. O disjuntor de
 * bounce existe justamente para o que passar daqui e não entregar.
 */
/**
 * O status que a Lusha afirma, quando afirma. `null` quando não há sinal.
 *
 * Devolve `null` em vez de `accept_all` de propósito: quem chama precisa
 * distinguir "ela disse que é indeterminado" de "ela não disse nada", porque
 * no segundo caso ainda há a nota do e-mail para consultar.
 */
function traduzirStatusExplicito(bruto: unknown): StatusVerificacao | null {
  switch (typeof bruto === "string" ? bruto.toLowerCase() : bruto) {
    case "valid":
    case "verified":
    case true:
      return "valid";
    case "invalid":
    case "bounced":
    case false:
      return "invalid";
    default:
      return null;
  }
}

/**
 * Como a empresa entra no filtro: id exato, depois domínio, depois nome.
 *
 * `ids` é o caminho que faz a descoberta pela Lusha valer a pena. A empresa
 * veio do grafo dela com um id; pedir os contatos por esse id não depende de
 * nenhum casamento de texto. Domínio e nome ficam para empresa que veio de
 * outra fonte.
 */
function empresaNoFiltro(input: {
  idExterno?: string;
  dominio?: string;
  empresa?: string;
}): Record<string, unknown> | null {
  if (input.idExterno) return { ids: [input.idExterno] };
  if (input.dominio) return { domains: [input.dominio] };
  if (input.empresa) return { names: [input.empresa] };
  return null;
}

/**
 * O cargo vem em objeto — `jobTitle: {title, departments, seniority}` —, não
 * em texto.
 *
 * Eu lia como string e recebia `null` em todo contato: o lead nasceria sem
 * cargo, e a coluna vazia na tela pareceria "a Lusha não tem esse dado" em
 * vez de "eu li errado". Os nomes planos ficam como alternativa porque o
 * enriquecimento pode devolver noutro formato.
 */
function cargoDe(bruto: Record<string, unknown>): string | null {
  const aninhado = bruto.jobTitle;
  if (typeof aninhado === "object" && aninhado !== null) {
    const t = texto(aninhado as Record<string, unknown>, "title", "name");
    if (t) return t;
  }
  return texto(bruto, "jobTitle", "job_title", "title", "position");
}


/**
 * Escolhe o e-mail entre os que a Lusha devolveu.
 *
 * `results.emails` é uma lista de `{email, type, confidence, updateDate}`,
 * com `type` valendo "work", "private" ou "unknown". O corporativo vem
 * primeiro de propósito: o pessoal não é o contato de trabalho da pessoa, e
 * prospectar num endereço particular é problema sob a LGPD, não só má
 * educação.
 *
 * `confidence` é LETRA ("A+", "B"), não número — ler como número devolveria
 * nada e jogaria fora o único sinal de qualidade que ela dá.
 */
function escolherEmail(
  bruto: Record<string, unknown>,
): { endereco: string; confianca: number | null; nota: string | null } | null {
  const lista = objetos(bruto.emails);

  const corporativo = lista.find((e) => texto(e, "type") === "work");
  const naoPessoal = lista.find((e) => texto(e, "type") !== "private");
  const escolhido = corporativo ?? naoPessoal ?? lista[0];

  const endereco =
    (escolhido ? texto(escolhido, "email", "address", "value") : null) ??
    texto(bruto, "email", "emailAddress", "email_address");
  if (!endereco) return null;

  const nota = escolhido ? texto(escolhido, "confidence") : null;
  return { endereco, confianca: notaEmNumero(nota), nota };
}

/**
 * A nota do e-mail vira a verificação que a cadeia entende.
 *
 * Isto decide se o lead SAI. `paraNovoLead` só marca `email_verified` quando
 * a verificação é `valid`, e `listarProntosParaContato` só enfileira
 * verificado — então um lead que chega como `accept_all` fica enriquecido e
 * parado para sempre, porque nada o reverifica depois.
 *
 * A nota da Lusha é justamente a confiança dela no endereço, e estava sendo
 * ignorada: todo lead virava `accept_all` e o funil parava calado no envio.
 * A+ e A são afirmação de qualidade — valem `valid`. B para baixo é
 * indeterminação, e indeterminado espera: é o endereço com maior chance de
 * voltar como bounce, e o disjuntor existe justamente porque bounce custa
 * reputação de domínio.
 */
function verificacaoDaNota(nota: string | null): StatusVerificacao | null {
  switch (nota?.toUpperCase()) {
    case "A+":
    case "A":
      return "valid";
    case "B":
    case "C":
    case "D":
      return "accept_all";
    default:
      return null;
  }
}

/**
 * A nota de confiança da Lusha em número.
 *
 * Ela usa letra; a cadeia compara números para escolher entre candidatos e
 * para o disjuntor de bounce. Sem esta conversão todo contato empataria no
 * valor sintético e a ordenação por qualidade deixaria de existir.
 */
function notaEmNumero(nota: string | null): number | null {
  switch (nota?.toUpperCase()) {
    case "A+":
      return 95;
    case "A":
      return 90;
    case "B":
      return 75;
    case "C":
      return 60;
    case "D":
      return 45;
    default:
      return null;
  }
}

function paraCandidato(
  bruto: Record<string, unknown>,
  fonte: "lusha_finder" | "lusha_domain",
): CandidatoDecisor | null {
  const escolhido = escolherEmail(bruto);
  if (!escolhido) return null;

  const inteiro = texto(bruto, "name", "fullName", "full_name");
  const partido = [
    texto(bruto, "firstName", "first_name"),
    texto(bruto, "lastName", "last_name"),
  ]
    .filter((p): p is string => p !== null)
    .join(" ");

  return {
    nome: inteiro ?? (partido || null),
    cargo: cargoDe(bruto),
    email: escolhido.endereco,
    /**
     * A nota da Lusha quando ela dá; 75 sintético quando não.
     *
     * 75 fica acima do 70 do e-mail declarado à Receita (que pode estar
     * velho) e abaixo do que só uma verificação de verdade justificaria.
     */
    confianca:
      escolhido.confianca ??
      numero(bruto, "confidence", "score", "emailConfidence") ??
      75,
    /**
     * O status explícito quando vem; senão, a nota do e-mail.
     *
     * A ordem importa: um campo de status é afirmação direta da Lusha, e a
     * nota é a confiança dela. Só quando nenhum dos dois existe é que cai em
     * `accept_all` — indeterminado, que não sai da fila de envio.
     */
    verificacao:
      traduzirStatusExplicito(
        bruto.emailStatus ?? bruto.email_status ?? bruto.isValid ?? bruto.status,
      ) ??
      verificacaoDaNota(escolhido.nota) ??
      "accept_all",
    fonte,
  };
}

/**
 * Acha uma pessoa específica na empresa. Equivale ao email-finder da Hunter.
 *
 * Uma chamada só: `search-and-enrich` aceita `firstName` + `lastName` +
 * `companyDomain` como identificador e já revela o e-mail. Separar em busca e
 * enriquecimento aqui seria uma ida a mais ao servidor pelo mesmo custo — a
 * cobrança é a mesma nos dois caminhos (uma de busca, uma de revelação).
 */
export async function acharEmailPorNome(
  input: {
    idExterno?: string;
    dominio?: string;
    empresa?: string;
    primeiroNome: string;
    sobrenome: string;
    apiKey: string;
  },
  deps: { fetch?: FetchLike } = {},
): Promise<CandidatoDecisor | null> {
  if (!input.dominio && !input.empresa) return null;

  const identificador: Record<string, unknown> = {
    // A doc pede um id por contato para casar pedido e resposta em lote.
    // Aqui é sempre um só, mas mandar o campo evita depender da ordem.
    contactId: "1",
    firstName: input.primeiroNome,
    lastName: input.sobrenome,
  };
  if (input.dominio) identificador.companyDomain = input.dominio;
  else identificador.companyName = input.empresa;

  let resposta: unknown;
  try {
    resposta = await postar<unknown>(
      "/contacts/search-and-enrich",
      { contacts: [identificador], reveal: REVELAR },
      { apiKey: input.apiKey, fetch: deps.fetch },
    );
  } catch (erro) {
    // Ou relança traduzido, ou devolve vazio no caso do 451 — que aqui
    // significa "não temos este contato para entregar".
    traduzirErro(erro);
    return null;
  }

  const encontrados = listaDeResultados(resposta);
  if (encontrados.length === 0) return null;

  const candidatos = encontrados
    .map((c) => paraCandidato(c, "lusha_finder"))
    .filter((c): c is CandidatoDecisor => c !== null);

  /**
   * Achou contato mas nenhum com e-mail legível: pode ser contato sem e-mail
   * no acervo (legítimo) ou campo renomeado (defeito). Devolver `null` é o
   * certo para a cadeia — ela segue para a próxima fonte — e o caso de campo
   * renomeado é pego pela busca por cargo, que lança.
   */
  if (candidatos.length === 0) return null;
  return [...candidatos].sort((a, b) => b.confianca - a.confianca)[0]!;
}

/**
 * Acha decisores pelo cargo dentro da empresa. Equivale ao domain-search.
 *
 * Duas etapas: `prospecting` filtra e devolve prévia sem PII, `enrich` revela
 * o e-mail — e é só no segundo que o crédito de revelação é gasto.
 *
 * O filtro de cargo vem de `cargos` — os títulos como a campanha os escreveu,
 * em português — e entra como `jobTitles`, que é texto livre.
 *
 * NÃO usa `departamento`. Aquilo é a sigla da Hunter (`finance`, `it`,
 * `operations`), derivada dos cargos por `alvoDaCampanha` para o vocabulário
 * DELA. Mandar `jobTitles: ["finance"]` procura literalmente por alguém com o
 * título "finance", que não casa com ninguém — e o resultado vazio se
 * disfarçaria de "a Lusha não tem contato nesta empresa".
 *
 * O `departments` da Lusha também não serve: é lista fechada, alimentada por
 * `/v3/contacts/prospecting/filters/departments`, e a sigla da Hunter não é
 * garantidamente um valor válido lá.
 */
export async function buscarNoDominio(
  input: {
    idExterno?: string;
    dominio?: string;
    empresa?: string;
    departamento?: string;
    cargos?: readonly string[];
    senioridade?: string;
    apiKey: string;
  },
  deps: { fetch?: FetchLike } = {},
): Promise<CandidatoDecisor[]> {
  const empresas = empresaNoFiltro(input);
  if (!empresas) return [];

  const chamada = { apiKey: input.apiKey, fetch: deps.fetch };

  const titulos = (input.cargos ?? []).filter(
    (c) => typeof c === "string" && c.trim().length > 0,
  );

  const contatos: Record<string, unknown> = {};
  if (titulos.length > 0) contatos.jobTitles = titulos;
  // `seniorityIds` é o nome certo e ele quer NÚMEROS (`[4,5]`), não texto. A
  // cadeia hoje não preenche senioridade; deixar o campo errado montado seria
  // um 400 esperando o primeiro alvo que a use.

  /** Monta e dispara uma busca, com ou sem filtro de cargo. */
  const buscar = async (filtroDeContato: Record<string, unknown> | null) =>
    postar<unknown>(
      "/contacts/prospecting",
      {
        // A página vai no mínimo aceito; quem limita o resultado é o
        // `maxContactsPerCompany` abaixo.
        pagination: { page: 0, size: PAGINA_MINIMA },
        filters: {
          companies: { include: empresas },
          ...(filtroDeContato ? { contacts: { include: filtroDeContato } } : {}),
        },
        options: { maxContactsPerCompany: POR_EMPRESA },
      },
      chamada,
    );

  let busca: unknown;
  try {
    busca = await buscar(Object.keys(contatos).length ? contatos : null);
  } catch (erro) {
    return traduzirErro(erro);
  }

  let encontrados = listaDeResultados(busca);

  /**
   * Vazio com filtro de cargo: tenta de novo SEM o filtro.
   *
   * "Nenhum contato" tem duas causas que a mesma resposta não distingue: a
   * Lusha não tem ninguém desta empresa, ou tem e os cargos não casaram. A
   * segunda é bem provável aqui — os cargos vêm em português ("Diretor de
   * Operações") e o índice dela é majoritariamente em inglês.
   *
   * Sem esta segunda busca, as duas viram "vazio" e a conclusão errada é
   * "a Lusha não cobre empresa brasileira". Custa uma chamada, e só quando a
   * primeira não achou nada — que é exatamente quando a informação vale.
   *
   * O que voltar daqui não respeita o cargo-alvo, e é de propósito: quem
   * revisa o lead vê o cargo real e decide. Melhor um contato com cargo
   * diferente do pedido do que nenhum contato e nenhuma explicação.
   */
  let semFiltroDeCargo = false;
  if (encontrados.length === 0 && Object.keys(contatos).length > 0) {
    try {
      encontrados = listaDeResultados(await buscar(null));
      semFiltroDeCargo = encontrados.length > 0;
    } catch (erro) {
      return traduzirErro(erro);
    }
  }

  if (encontrados.length === 0) return [];

  /**
   * Só enriquece quem a Lusha diz que TEM e-mail para revelar.
   *
   * A busca devolve `canReveal: [{field: "emails", credits: N}]` e `has`. O
   * enriquecimento é a etapa que cobra por e-mail revelado — mandar um
   * contato sem e-mail no acervo gasta a chamada e devolve nada.
   *
   * Quando a resposta não traz nenhum dos dois campos, o contato passa: a
   * ausência do sinal não é um "não", e recusar por falta de informação
   * transformaria um formato inesperado em "empresa sem decisor".
   */
  const comEmail = encontrados.filter((c) => {
    const podeRevelar = objetos(c.canReveal).map((r) => texto(r, "field"));
    const tem = Array.isArray(c.has)
      ? c.has.filter((h): h is string => typeof h === "string")
      : [];
    if (podeRevelar.length === 0 && tem.length === 0) return true;
    return podeRevelar.includes("emails") || tem.includes("emails");
  });

  /**
   * Corta em `POR_EMPRESA` antes de enriquecer.
   *
   * A busca precisa pedir a página mínima de 10, mas o enriquecimento é a
   * etapa que COBRA — por e-mail revelado. Mandar os dez ids que a página
   * trouxe pagaria dez revelações para usar uma.
   */
  const ids = comEmail
    .map((c) => texto(c, "id", "contactId"))
    .filter((id): id is string => id !== null)
    .slice(0, POR_EMPRESA);

  if (ids.length === 0) {
    throw new Error(
      `Lusha devolveu ${encontrados.length} contato(s) sem identificador reconhecível. ` +
        `Campos vistos: ${formaRecebida(encontrados[0])}`,
    );
  }

  let enriquecidos: unknown;
  try {
    enriquecidos = await postar<unknown>(
      "/contacts/enrich",
      // `ids`, não `contactIds`: a API recusa o segundo com "property
      // contactIds should not exist".
      { ids, reveal: REVELAR },
      chamada,
    );
  } catch (erro) {
    return traduzirErro(erro);
  }

  const lista = listaDeResultados(enriquecidos);
  if (lista.length === 0) {
    throw new Error(
      `Lusha aceitou o enriquecimento mas não devolveu contato reconhecível. ` +
        `Forma recebida: ${formaRecebida(enriquecidos)}`,
    );
  }

  return lista
    .map((c) => paraCandidato(c, "lusha_domain"))
    .filter((c): c is CandidatoDecisor => c !== null)
    /**
     * Contato achado sem o filtro de cargo entra com confiança menor.
     *
     * Ele é da empresa certa, mas não necessariamente o cargo pedido — a
     * segunda busca não filtra. Marcar isso no número é o que permite
     * distinguir, depois, "achamos o decisor" de "achamos alguém lá dentro".
     */
    .map((c) => (semFiltroDeCargo ? { ...c, confianca: Math.min(c.confianca, 55) } : c));
}

/**
 * A Lusha não verifica e-mail avulso.
 *
 * Devolve `unknown`, que a cadeia não aprova — de propósito. Este caminho só é
 * usado para o e-mail declarado à Receita, que chega sem verificação nenhuma;
 * aprová-lo sem conferir mandaria e-mail para endereço possivelmente morto e
 * alimentaria o disjuntor de bounce. Os candidatos vindos da própria Lusha
 * nunca passam por aqui: já chegam com status próprio.
 */
export async function verificarEmail(): Promise<{
  status: StatusVerificacao;
  score: number;
}> {
  return { status: "unknown", score: 0 };
}
