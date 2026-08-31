import { describe, it, expect } from "vitest";
import {
  canTransition,
  assertTransition,
  isTerminal,
} from "../../src/domain/stages.js";

describe("canTransition", () => {
  it("permite o caminho feliz completo do funil", () => {
    expect(canTransition("discovered", "enriched")).toBe(true);
    expect(canTransition("enriched", "contacted")).toBe(true);
    expect(canTransition("contacted", "in_conversation")).toBe(true);
    expect(canTransition("in_conversation", "meeting_booked")).toBe(true);
  });

  it("permite descartar a partir de qualquer estágio não terminal", () => {
    expect(canTransition("discovered", "discarded")).toBe(true);
    expect(canTransition("enriched", "discarded")).toBe(true);
    expect(canTransition("contacted", "discarded")).toBe(true);
    expect(canTransition("in_conversation", "discarded")).toBe(true);
  });

  it("permite marcar erro a partir de qualquer estágio não terminal", () => {
    expect(canTransition("discovered", "error")).toBe(true);
    expect(canTransition("in_conversation", "error")).toBe(true);
  });

  it("proíbe pular etapas do funil", () => {
    expect(canTransition("discovered", "contacted")).toBe(false);
    expect(canTransition("enriched", "meeting_booked")).toBe(false);
  });

  it("proíbe retroceder no funil", () => {
    expect(canTransition("contacted", "enriched")).toBe(false);
    expect(canTransition("meeting_booked", "in_conversation")).toBe(false);
  });

  it("proíbe sair de estágios terminais", () => {
    expect(canTransition("meeting_booked", "discarded")).toBe(false);
    expect(canTransition("discarded", "contacted")).toBe(false);
  });

  it("permite sair de erro voltando ao estágio de origem para reprocessar", () => {
    expect(canTransition("error", "discovered")).toBe(true);
    expect(canTransition("error", "enriched")).toBe(true);
    expect(canTransition("error", "contacted")).toBe(true);
    expect(canTransition("error", "in_conversation")).toBe(true);
  });

  it("trata transição para o mesmo estágio como inválida", () => {
    expect(canTransition("contacted", "contacted")).toBe(false);
  });
});

describe("assertTransition", () => {
  it("não lança em transição válida", () => {
    expect(() => assertTransition("enriched", "contacted")).not.toThrow();
  });

  it("lança citando origem e destino em transição inválida", () => {
    expect(() => assertTransition("discovered", "meeting_booked")).toThrow(
      /discovered.*meeting_booked/,
    );
  });
});

describe("isTerminal", () => {
  it("reconhece reunião marcada e descartado como terminais", () => {
    expect(isTerminal("meeting_booked")).toBe(true);
    expect(isTerminal("discarded")).toBe(true);
  });

  it("não considera erro terminal, pois é reprocessável", () => {
    expect(isTerminal("error")).toBe(false);
  });

  it("não considera estágios do meio do funil terminais", () => {
    expect(isTerminal("contacted")).toBe(false);
  });
});
