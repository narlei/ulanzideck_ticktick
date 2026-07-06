# PLAN.md — Plugin UlanziDeck para o Pomodoro/Foco do TickTick

> Plugin nativo do UlanziDeck (JS/Node, mesmo padrão do `ulanzidesk_claude`) que
> controla e reflete o **foco ao vivo** do TickTick a partir de um único botão.

---

## 1. Objetivo e escopo (v1)

Um **botão inteligente** que:

- **Inicia** um foco de 25 min pelo Deck.
- **Pausa/continua** o foco em andamento com o mesmo clique.
- Ao terminar o foco, oferece e **inicia** o relax de 5 min.
- **Detecta** foco iniciado/pausado em **outro aparelho** (Mac, celular) e reflete no botão.
- Mostra o **tempo restante ao vivo** (MM:SS) no botão.

**Fora do escopo do v1** (ver §12): encerrar/abandonar pelo Deck, modo cronômetro
(timing/type 1), seleção de tarefa, botão de estatística, suporte a dial/knob.

---

## 2. Decisões travadas (resultado do grill)

| Tema | Decisão |
|---|---|
| **Auth** | Plugin faz `POST /api/v2/user/signin` (email+senha no property inspector) → guarda só o token. Fallback: colar cookie `t` manualmente. |
| **Storage do token** | `setGlobalSettings` do SDK (compartilhado, sem arquivo, sem Keychain/prompt). |
| **Actions** | **1 action** só ("Focus"), botão inteligente. |
| **Clique** | Alterna **focar ↔ pausar/continuar**. **Nunca encerra** pelo Ulanzi. |
| **Fim do foco** | Botão mostra "Relax 5'?" → clique inicia o break. Fim do break → ocioso. |
| **Sync** | Server-authoritative + tick local. Polling do estado a cada **~30s** (visível), pausa quando inativo; clique relê na hora. |
| **Durações** | Lê de `/user/preferences/pomodoro` (fallback 25/5), com override no PI. |
| **Tarefa** | Foco simples (`focusOnId` vazio) no v1. |
| **Device** | Keypad (`Controllers: ["Keypad"]`). |

---

## 3. Arquitetura

Segue a convenção dos plugins existentes (`com.claude.usage.ulanziPlugin`):

```
ticktickfocus.ulanziPlugin/
├── manifest.json                 # 1 action, Type JavaScript, PrivateAPI true, OS mac
├── package.json                  # ES modules, deps mínimas
├── plugin/
│   ├── app.js                    # ciclo de vida + máquina de estados + polling
│   ├── plugin-common-node/       # submódulo SDK (UlanziApi) — reutilizar
│   ├── ticktick-client.js        # auth + chamadas à API (signin, focusOp, prefs)
│   ├── focus-state.js            # deriva o estado lógico do `current` + tick local
│   └── renderer.js               # SVG → dataURL por estado (baseado no do Claude)
├── property-inspector/
│   ├── inspector.html            # login (email/senha) + fallback colar token + overrides
│   └── inspector.js
├── resources/                    # icon.png, action.png
├── <locale>.json                 # en/pt_BR/… (poucas strings)
├── Makefile                      # build/zip/bump (reusar do ulanzidesk_claude)
└── .github/workflows/release.yml # release automática no bump de Version (reusar)
```

**Runtime:** Node embutido do UlanziDeck, ES modules, `fetch` nativo, `AbortController`
com timeout (mesmo padrão do `usage-fetcher.js`). Sem dependências pesadas.

---

## 4. Autenticação

### 4.1 Fluxo primário (signin)
1. Property inspector coleta **email + senha**.
2. PI manda pro plugin (`sendToPlugin`); o plugin chama:
   ```
   POST https://api.ticktick.com/api/v2/user/signin?wc=true&remember=true
   Content-Type: application/json
   { "username": "<email>", "password": "<senha>" }
   ```
3. Resposta traz o **token** no corpo (o valor do cookie `t`). Guarda em
   `setGlobalSettings({ token, savedAt })`. **A senha nunca é persistida.**

### 4.2 Fallback (colar token)
Campo no PI pra colar o cookie `t` (DevTools → Application → Cookies) — usado se
algum dia aparecer captcha/2FA. (Conta atual está com `isMFAOpen:false`.)

### 4.3 Uso do token
Todas as chamadas às APIs privadas mandam:
```
Cookie: t=<token>
Content-Type: application/json
```
✅ **Validado ao vivo:** o host `ms.ticktick.com/focus` aceita só isso (sem `x-device`).

### 4.4 Expiração / reauth
- `401`/`user_not_sign_on` → estado **REAUTH** no botão (ícone ↻), e o PI permite
  refazer o login. Mesmo padrão do `renderReauth` do plugin do Claude.
- Sem token salvo → estado **NO_TOKEN** ("Login TickTick").

---

## 5. Referência da API (descoberta por inspeção do webapp autenticado)

> ⚠️ **API privada, não oficial.** Pode mudar sem aviso. Auth = cookie de sessão.

### 5.1 Estado ao vivo do foco — host `ms.ticktick.com`
**Ler o estado atual** (sem mutar — `opList` vazio):
```
POST https://ms.ticktick.com/focus/batch/focusOp
{ "lastPoint": 0, "opList": [] }
→ { "point": <ts>, "current": { id, type, status, valid, exited,
      duration, startTime, endTime, pauseDuration,
      focusBreak: { duration, startTime }, focusTasks, etag, autoStart } }
```

**Operações** (mandar no `opList`):

| Ação | `op` | `duration` |
|---|---|---|
| Iniciar foco | `"start"` | 25 (min) |
| Iniciar break | `"startBreak"` | 5 (min) |
| Pausar | `"pause"` | 0 |
| Continuar | `"continue"` | 0 |
| Encerrar (⚠️ não usado no v1) | `"exit"` | 0 |

Formato de uma operação:
```json
{ "id": "<opId 24-hex novo>", "oId": "<sessionId 24-hex>", "oType": 0,
  "op": "start", "duration": 25, "firstFocusId": "<sessionId>",
  "focusOnId": "", "autoPomoLeft": <n>, "pomoCount": <n>,
  "manual": true, "note": "", "time": "<ISO 8601 +0000>" }
```
> IDs são strings hex de 24 chars geradas no cliente. `pause`/`continue` a confirmar
> no Passo 0 (nome exato do `op`), capturando pelos botões Pause/Continue do webapp.

### 5.2 Config e estatística — host `api.ticktick.com/api/v2`
- `GET /user/preferences/pomodoro` → `{ pomoDuration:25, shortBreakDuration:5, longBreakDuration:15, longBreakInterval:4, pomoGoal, autoPomo, autoBreak }`
- (futuro) `GET /pomodoros/statistics/generalForDesktop` → contagens do dia.

---

## 6. Máquina de estados do botão

Estados lógicos derivados do `current` (em `focus-state.js`):

| Estado | Como é detectado | Clique faz | Render |
|---|---|---|---|
| **IDLE** | sem sessão ativa / `exited` / `status` ocioso | `op:start` (foco 25') | ícone TickTick + "Focus" |
| **FOCUSING** | `!exited` e `endTime > agora` e sem break ativo | `op:pause` | anel/tempo **MM:SS** decrescendo |
| **PAUSED** | sessão ativa com pausa vigente | `op:continue` | MM:SS estático + "⏸" |
| **BREAK_PROMPT** | foco completou (`agora ≥ endTime`, sem break) | `op:startBreak` (5') | "Relax 5'?" |
| **BREAK** | `focusBreak` ativo e não expirado | `op:pause`/`continue` | MM:SS do break (cor diferente) |
| **NO_TOKEN** | sem token salvo | abre PI | 🔒 "Login TickTick" |
| **REAUTH** | 401 / token inválido | abre PI | ↻ "Reauth" |
| **ERROR** | rede/timeout | força releitura | ⚠ + último estado bom (stale dot) |

Regras:
- **Nunca** emite `op:exit` (decisão do usuário).
- Completar foco/break é detectado **localmente** (`agora ≥ endTime`), sem esperar o poll.
- Transições de clique são **otimistas** (atualiza UI na hora) + releitura imediata do `current`.

---

## 7. Modelo de sincronização

- **Fonte de verdade:** `current` do servidor. Poll a cada **30s** enquanto a action
  está visível/ativa; pausa via `onSetActive(false)` (igual ao Claude).
- **Tick local:** enquanto FOCUSING/BREAK e visível, um `setInterval(1s)` recalcula
  `restante = endTime − agora − pausas` e re-renderiza o MM:SS (não bate na API).
- **Clique:** envia o `op`, aplica estado otimista, e faz **releitura imediata** do
  `current` pra confirmar (cobre corrida com outros aparelhos).
- **Poll mesmo IDLE:** necessário pra detectar foco iniciado no celular (aparece em ≤30s).
- **Guardas** (padrão do `usage-fetcher.js`): `inflight` lock, timeout 15s, cache
  `lastGood`, jitter no start do timer.

> Observação (validada): um `op` enviado pela API **não para o timer local de um app
> aberto** — cada cliente reconcilia via `focusOp`. Como o v1 nunca encerra pelo Deck
> e o usuário costuma usar um device por vez, tratamos o `current` do servidor como
> verdade e acionamos releitura no clique.

---

## 8. Property Inspector

- **Email** + **Senha** → botão "Entrar" (dispara signin no plugin).
- **Status** da conexão (Conectado ✓ / Erro / Não logado) + botão "Sair".
- **Avançado:** campo "colar token `t`" (fallback).
- **Overrides opcionais:** duração do foco / duração do break (default = preferências
  do TickTick).

---

## 9. Renderização (SVG → dataURL)

Reaproveita as helpers do `renderer.js` do Claude (`svgDoc`, `toDataUrl`,
`textWithShadow`, 200×200). Telas:

- **IDLE:** logo TickTick + "Focus".
- **FOCUSING:** MM:SS grande + barra/anel de progresso (verde), decrescendo.
- **PAUSED:** MM:SS + "⏸" (âmbar).
- **BREAK_PROMPT:** "Relax 5'?" com destaque.
- **BREAK:** MM:SS (azul/ciano) + rótulo "Break".
- **NO_TOKEN / REAUTH / ERROR:** telas neutras (padrão `renderNeutral`).

---

## 10. Manifest, naming e distribuição

- **UUID:** `com.narlei.ticktickfocus.plugin` (segue seu padrão `com.narlei.*`).
- **Dir:** `com.ticktick.focus.ulanziPlugin` (ou `ticktickfocus.ulanziPlugin`).
- **manifest.json:** 1 action, `Type: JavaScript`, `CodePath: plugin/app.js`,
  `PrivateAPI: true`, `OS: [{mac, 10.15}]`, `Software.MinVersion` conforme SDK atual.
- **Makefile + GitHub Actions:** reutilizar de `ulanzidesk_claude` (zip do `.ulanziPlugin`,
  release automática no bump de `Version`).
- Repo já está em `/Volumes/FILES_NARLEI/Sources/ulanzideck_ticktick` (vazio, greenfield).

---

## 11. Fases de implementação

**Fase 0 — Validação da API (de-risk, antes de codar UI)**
- [ ] Confirmar que o `token` do `signin` autentica no host `ms` (cookie `t`).
- [ ] Capturar os nomes exatos dos `op` de **pause/continue** (clicando no webapp).
- [ ] Confirmar shape de `current` em cada transição (start/pause/continue/complete/break).

**Fase 1 — Cliente da API** (`ticktick-client.js`)
- [ ] `signin(email, pass)` → token; `getState()` (empty op); `sendOp(op, dur)`; `getPomoPrefs()`.
- [ ] Geração de opId/sessionId (24-hex), timeout, tratamento de 401.

**Fase 2 — Estado + render** (`focus-state.js`, `renderer.js`)
- [ ] Derivar estado lógico do `current`; cálculo de restante com pausa.
- [ ] Telas SVG de todos os estados.

**Fase 3 — Ciclo de vida** (`app.js`)
- [ ] `onAdd`/`onRun`/`onSetActive`/`onClear`, poll 30s + tick 1s, ação otimista + releitura.

**Fase 4 — Property Inspector**
- [ ] Login/logout, status, fallback de token, overrides de duração.

**Fase 5 — Empacotar & testar**
- [ ] Rodar no **UlanziDeckSimulator** do SDK, depois no device real.
- [ ] Makefile/zip, ícones, locales, README, release.

---

## 12. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| API privada muda/quebra | Isolar tudo em `ticktick-client.js`; erros → estado ERROR sem crashar. |
| Token expira | Estado REAUTH + relogin no PI. |
| `signin` com captcha/2FA | Fallback de colar token; conta atual sem 2FA. |
| Reconciliação com app aberto | `current` do servidor = verdade; releitura no clique; v1 não encerra. |
| Long-press não confiável no Keypad | Evitado por decisão: clique só alterna focar↔pausar. |

---

## 13. Roadmap pós-v1

- Encerrar/abandonar (via long-press medido por keyDown/keyUp, ou 2ª action).
- Botão de **estatística** (pomodoros/duração do dia).
- **Seleção de tarefa** (foco amarrado a uma task).
- Modo **cronômetro** (timing/type 1).
- Suporte ao **dial/knob** (girar ajusta duração, press inicia/pausa, hold encerra).
