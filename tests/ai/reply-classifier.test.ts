import { describe, it, expect, vi } from "vitest";
import { classifyReply } from "../../src/ai/reply-classifier.js";
import { depsComParse } from "../helpers/ai-mock.js";

function classificacao(overrides: Record<string, unknown> = {}) {
  return {
    intent: "interested",
    confidence: 0.9,
    reasoning: "Pediu para conversar na semana que vem.",
    key_points: ["quer conversar"],
    ...overrides,
  };
}

describe("classifyReply", () => {
  it("devolve a classificação retornada pelo modelo", async () => {
    const esperado = classificacao();
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: esperado, stop_reason: "end_turn" });

    const resultado = await classifyReply(
      "Podemos conversar semana que vem?",
      depsComParse(parse),
    );

    expect(resultado).toEqual(esperado);
  });

  it("limita a confiança ao intervalo de 0 a 1", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: classificacao({ confidence: 1.7 }),
      stop_reason: "end_turn",
    });

    const acima = await classifyReply("Vamos marcar!", depsComParse(parse));
    expect(acima.confidence).toBe(1);

    parse.mockResolvedValue({
      parsed_output: classificacao({ confidence: -0.4 }),
      stop_reason: "end_turn",
    });
    const abaixo = await classifyReply("Não entendi", depsComParse(parse));
    expect(abaixo.confidence).toBe(0);
  });

  it("usa confiança zero quando o modelo devolve um número inválido", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: classificacao({ confidence: Number.NaN }),
      stop_reason: "end_turn",
    });

    const resultado = await classifyReply("Texto ambíguo", depsComParse(parse));
    expect(resultado.confidence).toBe(0);
  });

  it("usa o modelo configurado com system cacheável e esforço baixo", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: classificacao(), stop_reason: "end_turn" });

    await classifyReply("Obrigado, não temos interesse.", depsComParse(parse));

    const argumentos = parse.mock.calls[0]![0];
    expect(argumentos.model).toBe("claude-opus-5");
    expect(argumentos.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(argumentos.output_config.effort).toBe("low");
  });

  it("rejeita resposta vazia sem chamar o modelo", async () => {
    const parse = vi.fn();
    await expect(classifyReply("  ", depsComParse(parse))).rejects.toThrow(
      /resposta vazia/i,
    );
    expect(parse).not.toHaveBeenCalled();
  });

  it("lança erro quando o modelo não devolve saída estruturada", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: null, stop_reason: "refusal" });

    await expect(classifyReply("Qualquer texto", depsComParse(parse))).rejects.toThrow(
      /saída estruturada/,
    );
  });
});
