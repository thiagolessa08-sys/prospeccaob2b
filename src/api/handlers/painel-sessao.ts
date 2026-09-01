import { segredoConfere } from "../assinatura.js";
import {
  criarSessao,
  cabecalhoDeSessao,
  cabecalhoDeSaida,
} from "../sessao-painel.js";

export interface DepsSessaoDoPainel {
  /** `PAINEL_SENHA`. Vazia significa painel desligado. */
  senha: string;
}

interface CorpoDoLogin {
  senha?: unknown;
}

/**
 * Troca a senha do operador por um cookie de sessão.
 *
 * Senha vazia no ambiente devolve 503, não 401: a diferença importa para quem
 * está do outro lado da tela. 401 manda o operador procurar a senha certa;
 * 503 diz a verdade — ninguém configurou `PAINEL_SENHA` no serviço, e nenhuma
 * senha vai funcionar até que alguém configure.
 *
 * A variável é opcional no boot de propósito. Torná-la obrigatória faria o
 * deploy existente parar de subir no instante em que este código chegasse ao
 * Railway — trocando um painel ausente por um serviço inteiro fora do ar.
 */
export async function tratarLoginDoPainel(
  req: Request,
  deps: DepsSessaoDoPainel,
): Promise<Response> {
  if (!deps.senha) {
    return new Response(
      JSON.stringify({ erro: "painel sem senha configurada (PAINEL_SENHA)" }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  let corpo: CorpoDoLogin;
  try {
    corpo = (await req.json()) as CorpoDoLogin;
  } catch {
    return new Response(JSON.stringify({ erro: "corpo não é JSON válido" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const recebida = typeof corpo.senha === "string" ? corpo.senha : null;
  if (!segredoConfere(recebida, deps.senha)) {
    return new Response(JSON.stringify({ erro: "senha inválida" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": cabecalhoDeSessao(criarSessao(deps.senha)),
    },
  });
}

/**
 * Encerra a sessão.
 *
 * Não confere nada antes de apagar: pedir para sair é sempre atendido, e
 * exigir sessão válida para encerrar sessão deixaria um cookie corrompido
 * preso no navegador sem jeito de limpar pela própria tela.
 */
export function tratarSaidaDoPainel(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": cabecalhoDeSaida(),
    },
  });
}
