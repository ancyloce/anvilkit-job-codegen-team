## Source contract

The independent validator checks every rule below on the sealed source of every round; a rule it checks is never a matter of taste. Authority, highest first: the independent validator's failure, this source contract (with the exemplar), the plan, the reviewers' findings. Where the plan or a finding asks for something this contract forbids, follow the contract: the deviation is correct and is no finding, and a finding that asks for it, or that would undo a fix of the validator's failure, is void. Cite a rule by its id (for example C10) when it decides a question.

Tree
- C01 The root holds only component.json, package.json, pnpm-lock.yaml, the usage README (a .md file), an optional LICENSE and the directories src/, styles/ and assets/. Nothing else: no tsconfig.json or other TypeScript, bundler, PostCSS, Tailwind or Babel configuration, no .npmrc, no other lockfile, no node_modules, dist, build or out directory.
- C02 Every path segment uses only letters, digits, `.`, `_`, `@` and `-`; no two paths differ only in letter case; no links.
- C03 src/ holds only .ts and .tsx files and never a .d.ts file; styles/ holds only .css files, each declared and non-empty; assets/ holds only .svg, .png, .jpg, .jpeg, .webp, .gif, .woff2, .json or .txt files, each declared.

component.json and package.json (strict JSON objects, no duplicate keys)
- C04 component.json has exactly the keys schemaVersion (the number 1), componentId, puckType, entry ("src/index.tsx"), styles, resources, usage and editableFields, and interaction only when the brief asks for a click counter. Any other key (name, description, version, category or another) fails.
- C05 componentId and puckType are exactly the brief's; package.json's name is exactly the brief's package name and its version an exact semver such as 1.0.0.
- C06 styles lists at least one stylesheet under styles/; resources lists every file under assets/ and nothing else; neither lists a path twice.
- C07 Each editableFields entry has exactly name, type and default; the name is letters and digits in camelCase (no `_` or `-`) and unique; the type is one of text, textarea, number, select, radio, array, object, external, custom.
- C08 package.json has only the keys name, version, description, license and dependencies; dependencies are exact versions: `react` 19.3.0, `@puckeditor/core` 0.23.0, and `react-dom` 19.3.0 only if the code imports it.
- C09 pnpm-lock.yaml starts with `lockfileVersion: '9.0'` (a quoted string) and has exactly one importer '.' with no devDependencies, optionalDependencies or peerDependencies, whose dependencies are exactly those of package.json, each with specifier and version equal to the declared version.

Code (src/)
- C10 src/index.tsx exports one flat Puck ComponentConfig of this component, typed with `import type { ComponentConfig } from "@puckeditor/core"`: `export const config: ComponentConfig<Props> = { label, fields, defaultProps, render }` and `export default config;` (the same object), plus the component and, with `export type`, its props type. The object is never keyed by the Puck type and never wrapped in `components`; the host does that. Use `export default config;`, not `export { config as default }`.
- C11 config.fields has exactly the editableFields names; a Puck field configuration carries no `default`; defaultProps carries the declared defaults.
- C12 Imports are only react, react/jsx-runtime, @puckeditor/core and relative files under src/: no stylesheet, JSON or asset import, no dynamic `import()`, React.lazy or `import.meta`.
- C13 TypeScript compiles under strict mode with react-jsx and without Node types: no `process`, `require` or `Buffer`, no global `JSX` namespace (import `type JSX` or `type ReactNode` from "react" when a type needs one), and type-only re-exports use `export type`.
- C14 The component is first rendered on a server, in Node without a DOM: never read window, document, localStorage, sessionStorage, navigator or matchMedia while rendering or in a useState initializer; use them only inside useEffect or an event handler. A render returns at least one element and never throws.
- C15 The component renders from its props: never copy a prop into state, so a changed prop shows on the next render.
- C16 Every non-empty text or textarea default is visible text of the component on the first render, verbatim and in one piece: no change of case, truncation, splitting into separate elements or typing effect, and not only in an attribute. An aria-label, title, alt or placeholder value is not visible text, so it is never a text or textarea field with a non-empty default: it is a constant in code, or a text field with an empty default whose empty value the code replaces with a constant.
- C17 The code makes no request: no fetch, XMLHttpRequest, WebSocket or EventSource, and no image, frame, video, audio, font or script source, local or remote. An image or font ships under assets/ and is used only through a relative `url()` in a declared stylesheet; an inline `<svg>` element in JSX makes no request and is allowed. A fixed URL in code is only a link's href.
- C18 The validator clicks the component's first button: its handler never throws, navigates, opens a window or makes a request.
- C19 No `<style>` element or CSS-in-JS, and the code never adds, removes, disables or edits a stylesheet; styles come only from the declared stylesheets, which the host loads (an inline `style` attribute is allowed).
- C20 The code never contains React or Puck internals, such as the strings `data-puck-`, `Symbol.for("react.` or `ReactSharedInternals`.

Styles (styles/)
- C21 Every declared stylesheet parses as CSS and has at least one top-level rule (not only inside @media, @supports or @layer, and not on :root, html or body) whose selector matches the component's root element or an element inside it in its default render, and that sets a visible property such as color, background, padding, margin, border, font-size or display to a value other than the browser default. A stylesheet of only custom properties, only media queries or only hover or variant states fails.
- C22 A `url()` is a relative path to a file declared under assets/ (no data:, blob:, http:, https: or absolute path); an `@import` names only another declared stylesheet; no web font is fetched from elsewhere.
- C23 When interaction is declared, clicking the first button advances its counterAttribute (a `data-*` attribute) by the declared increment.
