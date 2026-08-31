import { describe, it, expect } from "vitest";
import {
  avaliarDisjuntor,
  LIMITE_DE_BOUNCE,
  AMOSTRA_MINIMA,
} from "../../src/domain/bounce.js";

describe("avaliarDisjuntor — amostra insuficiente", () => {
  it("não abre com menos envios que o mínimo, mesmo com bounce alto", () => {
    const estado = avaliarDisjuntor({ enviados: 3, bounces: 1 });
    expect(estado.abrir).toBe(false);
    expect(estado.motivo).toMatch(/amostra/i);
  });

  it("não abre com zero envios", () => {
    const estado = avaliarDisjuntor({ enviados: 0, bounces: 0 });
    expect(estado.abrir).toBe(false);
    expect(estado.taxa).toBeNull();
  });

  it("não reporta taxa quando a amostra é insuficiente", () => {
    const estado = avaliarDisjuntor({ enviados: 5, bounces: 5 });
    expect(estado.abrir).toBe(false);
    expect(estado.taxa).toBeNull();
  });
});

describe("avaliarDisjuntor — com amostra suficiente", () => {
  it("abre acima do limite", () => {
    const estado = avaliarDisjuntor({ enviados: 100, bounces: 4 });
    expect(estado.abrir).toBe(true);
    expect(estado.taxa).toBeCloseTo(0.04);
    expect(estado.motivo).toMatch(/3/);
  });

  it("não abre exatamente no limite", () => {
    const estado = avaliarDisjuntor({ enviados: 100, bounces: 3 });
    expect(estado.abrir).toBe(false);
    expect(estado.taxa).toBeCloseTo(0.03);
  });

  it("não abre abaixo do limite", () => {
    const estado = avaliarDisjuntor({ enviados: 100, bounces: 2 });
    expect(estado.abrir).toBe(false);
  });

  it("avalia exatamente na amostra mínima", () => {
    const estado = avaliarDisjuntor({ enviados: AMOSTRA_MINIMA, bounces: 0 });
    expect(estado.taxa).toBe(0);
    expect(estado.abrir).toBe(false);
  });

  it("abre quando tudo deu bounce", () => {
    const estado = avaliarDisjuntor({ enviados: 50, bounces: 50 });
    expect(estado.abrir).toBe(true);
    expect(estado.taxa).toBe(1);
  });
});

describe("avaliarDisjuntor — entradas absurdas", () => {
  it("trata mais bounces que envios como 100%, sem passar de 1", () => {
    const estado = avaliarDisjuntor({ enviados: 30, bounces: 40 });
    expect(estado.taxa).toBe(1);
    expect(estado.abrir).toBe(true);
  });

  it("trata contagem negativa como zero", () => {
    const estado = avaliarDisjuntor({ enviados: 100, bounces: -5 });
    expect(estado.taxa).toBe(0);
    expect(estado.abrir).toBe(false);
  });

  it("não abre com contagem não-finita, e diz por quê", () => {
    const estado = avaliarDisjuntor({ enviados: Number.NaN, bounces: 10 });
    expect(estado.abrir).toBe(false);
    expect(estado.motivo).toMatch(/inválid/i);
  });
});

describe("constantes", () => {
  it("mantém o limite em 3% e a amostra mínima em 20", () => {
    expect(LIMITE_DE_BOUNCE).toBe(0.03);
    expect(AMOSTRA_MINIMA).toBe(20);
  });
});
