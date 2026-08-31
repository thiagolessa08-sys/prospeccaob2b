import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  assinaturaHmacConfere,
  segredoConfere,
} from "../../src/api/assinatura.js";

const SEGREDO = "segredo-do-webhook";
const CORPO = JSON.stringify({ triggerEvent: "BOOKING_CREATED", payload: {} });

function assinar(corpo: string, segredo = SEGREDO): string {
  return createHmac("sha256", segredo).update(corpo).digest("hex");
}

describe("assinaturaHmacConfere", () => {
  it("aceita a assinatura correta", () => {
    expect(assinaturaHmacConfere(CORPO, assinar(CORPO), SEGREDO)).toBe(true);
  });

  it("recusa assinatura de outro segredo", () => {
    expect(
      assinaturaHmacConfere(CORPO, assinar(CORPO, "outro-segredo"), SEGREDO),
    ).toBe(false);
  });

  it("recusa quando o corpo foi adulterado", () => {
    const assinatura = assinar(CORPO);
    expect(assinaturaHmacConfere(CORPO + " ", assinatura, SEGREDO)).toBe(false);
  });

  it("recusa assinatura ausente sem lançar", () => {
    expect(() => assinaturaHmacConfere(CORPO, null, SEGREDO)).not.toThrow();
    expect(assinaturaHmacConfere(CORPO, null, SEGREDO)).toBe(false);
  });

  it("recusa assinatura vazia sem lançar", () => {
    expect(assinaturaHmacConfere(CORPO, "", SEGREDO)).toBe(false);
  });

  it("recusa assinatura curta sem lançar — timingSafeEqual jogaria aqui", () => {
    expect(() => assinaturaHmacConfere(CORPO, "abc", SEGREDO)).not.toThrow();
    expect(assinaturaHmacConfere(CORPO, "abc", SEGREDO)).toBe(false);
  });

  it("recusa assinatura longa demais sem lançar", () => {
    expect(assinaturaHmacConfere(CORPO, assinar(CORPO) + "00", SEGREDO)).toBe(
      false,
    );
  });

  it("aceita corpo vazio assinado", () => {
    expect(assinaturaHmacConfere("", assinar(""), SEGREDO)).toBe(true);
  });

  it("recusa quando o segredo está vazio, em vez de aceitar qualquer coisa", () => {
    expect(assinaturaHmacConfere(CORPO, assinar(CORPO, ""), "")).toBe(false);
  });
});

describe("segredoConfere", () => {
  it("aceita o segredo correto", () => {
    expect(segredoConfere("abc123", "abc123")).toBe(true);
  });

  it("recusa segredo diferente", () => {
    expect(segredoConfere("abc124", "abc123")).toBe(false);
  });

  it("recusa segredo ausente sem lançar", () => {
    expect(() => segredoConfere(null, "abc123")).not.toThrow();
    expect(segredoConfere(null, "abc123")).toBe(false);
  });

  it("recusa segredo de tamanho diferente sem lançar", () => {
    expect(() => segredoConfere("abc", "abc123")).not.toThrow();
    expect(segredoConfere("abc", "abc123")).toBe(false);
  });

  it("recusa quando o esperado está vazio, para não virar porta aberta", () => {
    expect(segredoConfere("", "")).toBe(false);
    expect(segredoConfere(null, "")).toBe(false);
  });
});
