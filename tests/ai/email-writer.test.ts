import { describe, it, expect, vi } from "vitest";
import { writeFirstEmail } from "../../src/ai/email-writer.js";
import { depsComParse } from "../helpers/ai-mock.js";

const RASCUNHO = {
  subject: "Integração de dados na Alfa Alimentos",
  body: "Olá Maria, ...",
};

const ENTRADA = {
  voice: {
    offerDescription: "Consultoria de dados e BI para indústrias.",
    tone: "consultivo, direto, sem jargão",
  },
  company: {
    legalName: "Alfa Alimentos LTDA",
    tradeName: "Alfa Alimentos",
    summary: "Fabricante de congelados com três plantas em SC.",
    city: "Joinville",
    uf: "SC",
  },
  lead: { fullName: "Maria Souza", roleTitle: "Gerente de TI" },
};

describe("writeFirstEmail", () => {
  it("devolve o rascunho retornado pelo modelo", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: RASCUNHO, stop_reason: "end_turn" });

    const resultado = await writeFirstEmail(ENTRADA, depsComParse(parse));

    expect(resultado).toEqual(RASCUNHO);
  });

  it("mantém a oferta e o tom no system cacheável e os dados da empresa no turno do usuário", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: RASCUNHO, stop_reason: "end_turn" });

    await writeFirstEmail(ENTRADA, depsComParse(parse));

    const argumentos = parse.mock.calls[0]![0];
    const system = argumentos.system[0];
    expect(system.text).toContain("Consultoria de dados e BI para indústrias.");
    expect(system.text).toContain("consultivo, direto, sem jargão");
    expect(system.cache_control).toEqual({ type: "ephemeral" });
    // Dados voláteis ficam fora do prefixo cacheado.
    expect(system.text).not.toContain("Alfa Alimentos");

    const turnoUsuario = argumentos.messages[0].content as string;
    expect(turnoUsuario).toContain("Alfa Alimentos");
    expect(turnoUsuario).toContain("Maria Souza");
    expect(turnoUsuario).toContain("Gerente de TI");
  });

  it("produz o mesmo system para empresas diferentes da mesma campanha", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: RASCUNHO, stop_reason: "end_turn" });
    const deps = depsComParse(parse);

    await writeFirstEmail(ENTRADA, deps);
    await writeFirstEmail(
      {
        ...ENTRADA,
        company: { ...ENTRADA.company, legalName: "Beta Foods LTDA" },
      },
      deps,
    );

    expect(parse.mock.calls[0]![0].system[0].text).toBe(
      parse.mock.calls[1]![0].system[0].text,
    );
  });

  it("lida com empresa sem resumo e lead sem nome", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: RASCUNHO, stop_reason: "end_turn" });

    await writeFirstEmail(
      {
        ...ENTRADA,
        company: { ...ENTRADA.company, summary: null },
        lead: { fullName: null, roleTitle: "Diretor" },
      },
      depsComParse(parse),
    );

    const turnoUsuario = parse.mock.calls[0]![0].messages[0].content as string;
    expect(turnoUsuario).toContain("não disponível");
  });

  it("lança erro quando o modelo não devolve saída estruturada", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: null, stop_reason: "refusal" });

    await expect(writeFirstEmail(ENTRADA, depsComParse(parse))).rejects.toThrow(
      /saída estruturada/,
    );
  });
});
