## Exemplar

The validator's own certified fixture component, Hero. Copy its form, never its content: its identity, fields, texts, styles and asset are Hero's, not this component's. It shows the declaration, the package and the lockfile's first lines, the one flat ComponentConfig exported as `config` and as the default export, a component that renders from its props without browser APIs, and a stylesheet whose top-level rules style the rendered elements and use an asset only through `url()`. Hero declares `interaction` only because it counts clicks on its button: declare interaction only when the brief asks for a click counter.

component.json:
```json
{
  "schemaVersion": 1,
  "componentId": "cmp_hero_fixed",
  "puckType": "Hero",
  "entry": "src/index.tsx",
  "styles": ["styles/hero.css"],
  "resources": ["assets/mark.svg"],
  "usage": "README.md",
  "editableFields": [
    { "name": "title", "type": "text", "default": "Build once, certify exactly" },
    { "name": "subtitle", "type": "textarea", "default": "A reviewed fixed component: complete source, protected build, independent verdict." },
    { "name": "align", "type": "radio", "default": "left" },
    { "name": "ctaLabel", "type": "text", "default": "Get started" }
  ],
  "interaction": { "counterAttribute": "data-clicks", "increment": 1 }
}
```

package.json:
```json
{
  "name": "@anvilkit/hero-fixed",
  "version": "1.0.0",
  "description": "Reviewed fixed Hero component of the P10 certification chain (DEVELOPMENT fixture).",
  "license": "MIT",
  "dependencies": {
    "@puckeditor/core": "0.23.0",
    "react": "19.3.0"
  }
}
```

pnpm-lock.yaml (its first lines; the `packages` and `snapshots` sections that follow are not shown):
```yaml
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@puckeditor/core':
        specifier: 0.23.0
        version: 0.23.0(@floating-ui/dom@1.8.0)(@types/react-dom@19.3.0(@types/react@19.3.0))(@types/react@19.3.0)(react-dom@19.3.0(react@19.3.0))(react@19.3.0)(use-sync-external-store@1.7.0(react@19.3.0))
      react:
        specifier: 19.3.0
        version: 19.3.0
```

src/index.tsx:
```tsx
import type { ComponentConfig } from "@puckeditor/core";
import { Hero, type HeroProps } from "./hero";

/** The Puck component configuration: fields, defaults and the renderer. */
export const config: ComponentConfig<HeroProps> = {
	label: "Hero",
	fields: {
		title: { type: "text" },
		subtitle: { type: "textarea" },
		align: {
			type: "radio",
			options: [
				{ label: "Left", value: "left" },
				{ label: "Center", value: "center" },
			],
		},
		ctaLabel: { type: "text" },
	},
	defaultProps: {
		title: "Build once, certify exactly",
		subtitle: "A reviewed fixed component: complete source, protected build, independent verdict.",
		align: "left",
		ctaLabel: "Get started",
	},
	render: ({ title, subtitle, align, ctaLabel }) => <Hero title={title} subtitle={subtitle} align={align} ctaLabel={ctaLabel} />,
};

export { Hero };
export type { HeroProps };
export default config;
```

src/hero.tsx:
```tsx
import { useState } from "react";

export interface HeroProps {
	title: string;
	subtitle: string;
	align: "left" | "center";
	ctaLabel: string;
}

/**
 * The rendered component. It uses a hook so that a host serving a second
 * React instance fails visibly (hooks cannot cross React instances), which
 * the validator's host fixture relies on.
 */
export function Hero({ title, subtitle, align, ctaLabel }: HeroProps) {
	const [clicks, setClicks] = useState(0);
	return (
		<section className={`ak-hero ak-hero--${align}`} data-anvilkit-component="Hero">
			<span className="ak-hero__mark" aria-hidden="true" />
			<h1 className="ak-hero__title">{title}</h1>
			<p className="ak-hero__subtitle">{subtitle}</p>
			<button type="button" className="ak-hero__cta" data-clicks={clicks} onClick={() => setClicks(clicks + 1)}>
				{ctaLabel}
			</button>
		</section>
	);
}
```

styles/hero.css:
```css
/* Hero (fixed component). Plain CSS, no preprocessor, no dynamic classes. */
.ak-hero {
	box-sizing: border-box;
	padding: 24px;
	border-left: 4px solid rgb(17, 24, 39);
	font-family: system-ui, sans-serif;
	color: rgb(17, 24, 39);
	background: rgb(248, 250, 252);
}
.ak-hero--center {
	text-align: center;
	border-left-width: 0;
	border-top: 4px solid rgb(17, 24, 39);
}
.ak-hero__mark {
	display: inline-block;
	width: 32px;
	height: 32px;
	background-image: url("../assets/mark.svg");
	background-size: contain;
	background-repeat: no-repeat;
}
.ak-hero__title {
	margin: 8px 0 4px;
	font-size: 28px;
	line-height: 1.2;
}
.ak-hero__subtitle {
	margin: 0 0 16px;
	font-size: 16px;
	line-height: 1.5;
}
.ak-hero__cta {
	padding: 8px 16px;
	border: 0;
	border-radius: 4px;
	background: rgb(37, 99, 235);
	color: rgb(255, 255, 255);
	font: inherit;
	cursor: pointer;
}
```
