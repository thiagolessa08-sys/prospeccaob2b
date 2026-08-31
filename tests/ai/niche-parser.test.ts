import { describe, it, expect, vi } from "vitest";
import { parseNiche } from "../../src/ai/niche-parser.js";
import type { AiDeps } from "../../src/ai/client.js";

const FILTROS = {
  cnaes: ["1091101"],
  ufs: ["SC"],
  cities: [],
  min_employees: 50,
  max_employees: null,
  target_roles: ["Gerente de TI"],
  keywords: ["indústria de alimentos"],
};

function depsComParse(parse: ReturnType<typeof vi.fn>): AiDeps {
  return { client: { messages: { parse } } } as unknown as AiDeps;
}

describe("parseNiche", () => {
  it("devolve os filtros estruturados retornados pelo modelo", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: FILTROS, stop_reason: "end_turn" });

    const resultado = await parseNiche(
      "indústrias de alimentos em SC com 50+ funcionários, falar com gerente de TI",
      depsComParse(parse),
    );

    expect(resultado).toEqual(FILTROS);
  });

  it("chama o modelo configurado com system cacheável e saída estruturada", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: FILTROS, stop_reason: "end_turn" });

    await parseNiche("clínicas odontológicas em SP", depsComParse(parse));

    const argumentos = parse.mock.calls[0]![0];
    expect(argumentos.model).toBe("claude-opus-5");
    expect(argumentos.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(argumentos.output_config.format).toBeDefined();
    expect(argumentos.messages).toEqual([
      { role: "user", content: "clínicas odontológicas em SP" },
    ]);
  });

  it("lança erro quando o modelo não devolve saída estruturada", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: null, stop_reason: "refusal" });

    await expect(parseNiche("qualquer nicho", depsComParse(parse))).rejects.toThrow(
      /saída estruturada/,
    );
  });

  it("rejeita descrição vazia sem chamar o modelo", async () => {
    const parse = vi.fn();
    await expect(parseNiche("   ", depsComParse(parse))).rejects.toThrow(
      /descrição do nicho/i,
    );
    expect(parse).not.toHaveBeenCalled();
  });
});
