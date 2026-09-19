# opencode-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | **Español** | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **¿También usas zcode?** Echa un vistazo a [zcode-switchman](https://github.com/mrzturn/zcode-switchman) — un proyecto hermano de código abierto del mismo autor que lleva la misma orquestación a los usuarios de zcode.

> El contexto, bajo medición. Las tareas se despachan solas.

![opencode-switchman — the context water level drives the switchman and throws the route](docs/assets/hero.svg)

> Demo interactiva: [opencode-switchman en acción](https://mrzturn.github.io/opencode-switchman/)

Un plugin de orquestación para [OpenCode](https://opencode.ai). Hace dos cosas, y las hace bien:

**1. Control de nivel de agua del contexto.** El contexto de tu sesión se mide en cada turno. Las lecturas se rigen por un presupuesto por turno, así que el modelo no puede beberse el repositorio entero en silencio; las marcas de agua soft / hard / force disparan avisos, luego el cierre, y después un handover automático con backup y compactación; cada subagente despachado lleva su propio tope duro. El contexto deja de hacer bola de nieve: una sesión puede funcionar todo el día sin que su historial se devore los tokens.

**2. Despacho automatizado de decisiones.** Tu modelo principal se convierte en despachador: perfila cada tarea y la delega a shells de subagentes en seis carriles cognitivos (economy / mechanical / main / hard / vision / review). El plugin aplica compuertas deterministas, puntuación ponderada de modelos y aislamiento de fallos con autorreparación, y registra cada decisión de enrutamiento.

Además:

- **¿Varios modelos o varias suscripciones? Este plugin se hizo para ti.** GitHub Copilot, GLM Coding Plan, DeepSeek — o cualquier proveedor de opencode — se orquestan como un solo pool: orden consciente de cuota, evitación de ventanas pico y revisión cruzada entre familias obligatoria.
- **¿Un solo modelo? Sigue valiendo la pena.** El control de contexto y el despacho inteligente, por sí solos, mantienen un modelo utilizable indefinidamente — no importa cuánto corra la sesión, el contexto nunca se desborda.

## Instalación

Un solo comando: cubre la primera instalación y las actualizaciones posteriores. Reinicia opencode después.

```bash
curl -fsSL https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/scripts/setup.sh | bash
```

o

```bash
npx -y opencode-switchman@latest
```

o

```bash
bunx opencode-switchman@latest
```

Cualquiera de las dos vías reescribe la entrada `plugin` de tu configuración de opencode a la última versión exacta y poda las cachés obsoletas. Instalación manual con npm, compilación desde el código fuente y la nota sobre "por qué versiones exactas": [Detalles de instalación](./docs/reference.md#installation).

¿Prefieres no complicarte? Deja que tu IA haga la instalación — pega este prompt en la IA que estés usando:

<details open>
<summary><strong>Prompt de instalación asistida por IA</strong></summary>

```text
Por favor, instala y configura el plugin opencode-switchman en mi opencode, siguiendo estrictamente sus instrucciones oficiales.

Fuentes oficiales (autoritativas, no las deduzcas de memoria):
- Repositorio de GitHub: https://github.com/mrzturn/opencode-switchman
- Paquete npm: https://www.npmjs.com/package/opencode-switchman
Lee la sección "Installation" del README del repositorio y síguela al pie de la letra.

Pasos:
1. Instala la última versión publicada en npm: ejecuta `npx -y opencode-switchman@latest` (o `bunx opencode-switchman@latest`) — reescribe la entrada `plugin` de mi configuración de opencode a la última versión exacta (también funciona en el `opencode.json` a nivel de proyecto, si es lo que uso).
2. Completa la configuración funcional: todos los ajustes del plugin viven en el archivo independiente `opencode-switchman.jsonc` dentro de mi directorio de configuración de opencode, autogenerado con valores por defecto y comentarios en línea en el primer arranque; revísalo contra mis proveedores (p. ej. `zhipuai-coding-plan` / `deepseek` / `github-copilot`) y ajústalo según sea necesario.
3. Verifica que opencode cargue, arranque y ejecute el plugin: ejecuta `/switchman-doctor` dentro de opencode para obtener un informe de diagnóstico local sin credenciales y corrige cada error que reporte; luego reinicia opencode y confirma que el plugin realmente se cargó — el log debe contener `[opencode-switchman] injected N model shells (agents)` y el system prompt de mi modelo principal debe llevar el bloque de banner vivo `[ROUTES]/[WATERMARK]/[LIMITS]`.

No declares éxito hasta que los tres pasos pasen; informa de lo que cambiaste y muestra la evidencia de la verificación.
```

</details>

**Requisitos previos**: [opencode](https://opencode.ai), se recomienda CLI/TUI (los diálogos, la barra lateral y los banners lucen mejor ahí; la app de escritorio comparte la misma configuración y el mismo estado). Sirve cualquier proveedor; Copilot / GLM / DeepSeek además obtienen enrutamiento consciente de cuota. Las credenciales se leen en modo solo lectura desde la autenticación propia de opencode — el plugin nunca almacena secretos.

## Inicio rápido

Seis pasos. Guía completa con capturas: **[docs/quick-start.md](./docs/quick-start.md)** / [中文](./docs/quick-start.zh.md).

1. **Conecta proveedores** — `/connect` en la TUI: OAuth de Copilot, API key de DeepSeek; GLM Coding Plan va en `opencode.json` como proveedor personalizado `zhipuai-coding-plan`.
2. **Elige los modelos que entran en la orquestación** — `/models` y luego `ctrl+f` para marcar favoritos (app de escritorio: interruptores de "Manage models").
3. **`/switchman-setup`** *(necesario una sola vez)* — el asistente guiado cubre toda la matriz de una pasada: selección múltiple de al menos un modelo para cada uno de los seis pools de tareas (economy / mechanical / main / hard / vision / review) y, después, ordena los modelos elegidos del más fuerte al más débil. ¿Sin TUI? `/switchman-setup-chat` ejecuta el mismo flujo guiado en el chat. Hasta que la configuración se complete, el despacho de tareas queda bloqueado en firme — los pools sin configurar ya no usan por defecto "todos los modelos". La configuración guardada se recarga en caliente; reiniciar solo hace falta para registrar proveedores totalmente nuevos.
4. **Ajuste fino** *(opcional)* — **`/modelRank`** afina a mano el ranking de capacidades y **`/poolConfig`** curta las listas de candidatos por pool en diálogos de la TUI (variantes `-chat` en el chat); las entradas manuales sobrescriben los valores iniciales por defecto en todas partes.
5. **Comandos de contexto**
   - **`/handover`** — respalda la sesión y compacta tú mismo. Úsalo cuando la línea `[WATERMARK:SESSION]` crece demasiado o la tarea llega a un buen punto de pausa, en lugar de esperar el handover automático.
   - **`/ctx-pause`** — apaga los límites de lectura y el auto-handover de esta sesión. Úsalo cuando necesites leer muchos archivos grandes de golpe y no te importe gastar tokens; la medición sigue corriendo.
   - **`/ctx-resume`** — vuelve a encender los límites. Úsalo en cuanto termine la lectura pesada; reiniciar opencode tiene el mismo efecto.
6. **Reinicia y verifica** — revisa el banner `[ROUTES]`/`[LIMITS]` y el panel `switchman` de la barra lateral; ejecuta `/switchman-doctor` si algo se ve raro. Luego usa opencode con normalidad.

## Qué obtienes

**Núcleo**

- **Control de nivel de agua del contexto** — medición en vivo de la sesión (`[WATERMARK:SESSION]`), umbrales soft/hard/force, un presupuesto de lectura por turno que acota automáticamente las lecturas demasiado ávidas, un tope duro con resumen-y-terminación para cada subagente y un handover automático (fork con backup completo + compactación) en el nivel force.
- **Despacho automatizado de decisiones** — un protocolo de despacho incluido convierte tu modelo principal en despachador; seis carriles cognitivos llevan el trabajo al modelo correcto con el esfuerzo adecuado; seis compuertas deterministas revisan cada despacho; los fallos disparan breakers y aislamiento, y el sistema se repara solo.

**Extras**

- **Orquestación multi-suscripción** — enrutamiento consciente de cuota entre Copilot / GLM / DeepSeek (cualquier proveedor participa), cesión en ventanas pico, puntuación consciente de facturación y revisión cruzada entre familias obligatoria.
- **Anulaciones manuales** — `/switchman-setup`, `/poolConfig`, `/modelRank`, `/expert`, `/handover`, `/ctx-pause`, `/ctx-resume`, `/switchman-doctor`, `/switchman-update`.
- **Visibilidad** — banner vivo de cuatro líneas en cada system prompt, panel en la barra lateral de la TUI, espejo en paneles de tmux, workspace de artefactos por sesión y un log de auditoría de cada decisión de enrutamiento.

Tabla completa de opciones, arquitectura e internals: [docs/reference.md](./docs/reference.md) (中文: [docs/reference.zh.md](./docs/reference.zh.md)).

## Documentación

- Inicio rápido (ilustrado): [English](./docs/quick-start.md) · [中文](./docs/quick-start.zh.md)
- Manual completo (configuración, comandos, arquitectura): [English](./docs/reference.md) · [中文](./docs/reference.zh.md)
- Especificación técnica (contratos / algoritmos / notas de pruebas de campo): [docs/2026-08-28-opencode-switchman-technical-design.md](./docs/2026-08-28-opencode-switchman-technical-design.md)
- Notas de versión: [CHANGELOG.md](./CHANGELOG.md)

## Hoja de ruta

A corto plazo: soporte de cuota para más proveedores — más planes de suscripción y pools de pago por uso más allá de Copilot / GLM / DeepSeek. Si tu proveedor aún no está cubierto, [abre un issue](https://github.com/mrzturn/opencode-switchman/issues): el uso real decide qué se construye después. Sugerencias y reportes de bugs son igual de bienvenidos.

## Apoya al autor

Este plugin es de código abierto y de uso libre, y seguirá siéndolo. Mantenerlo con vida, sin embargo, no es gratis: dar soporte y probar la compatibilidad de adaptadores entre proveedores implica mantener varias suscripciones y depurarlas una por una — cada ronda cuesta dinero real.

Si el plugin te ha ayudado de verdad y tu presupuesto lo permite, invítame a un café. Gracias — de corazón.

👇

<details>
<summary>☕ Haz clic aquí 【Invita un café al autor】</summary>

| Alipay | WeChat Pay | Escanea con WeChat para darle un like |
|:---:|:---:|:---:|
| <img src="docs/pay/alipay.png" width="150" alt="Alipay QR code" /> | <img src="docs/pay/wechat_pay.jpg" width="150" alt="WeChat Pay QR code" /> | <img src="docs/pay/wechat_pay_2.jpg" width="150" alt="WeChat scan-to-like QR code" /> |

</details>

## Licencia

[MIT](./LICENSE)
