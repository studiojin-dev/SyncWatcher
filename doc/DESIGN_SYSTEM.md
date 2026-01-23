# SyncWatcher Look & Feel Design System

## "Unapologetically Raw" - Neo-Brutalism

---

## Design Philosophy

### Core Concept: Raw Functionalism

SyncWatcher's design is **bold, honest, and high-contrast**. We reject the "invisible" interface in favor of one that asserts its presence. Components are tools—they should look like tools. Borders are thick, shadows are hard, and colors are vibrant.

### Visual Language: Neo-Brutalism

- **Borders**: Thick (2px-3px), solid black (#000000). Every element is clearly defined.
- **Shadows**: Hard, offset shadows (e.g., 4px 4px 0 #000). No blur.
- **Colors**: High saturation, anti-aesthetic tones (Neo-Green, Hot Pink, Vivid Blue) paired with stark black and white.
- **Typography**: Raw, often monospaced headers. High readability with a technical edge.

### Interaction: Tactile & Mechanical

Buttons depress visually (shadow disappears). Toggles click. The interface feels mechanical and robust, like a well-machined physical instrument.

---

## Color System

### Palette (Light Mode)

```css
/* Base Canvas */
--bg-primary: #FFFFFF;        /* Stark White */
--bg-secondary: #F0F0F0;      /* Light Gray for backgrounds */
--bg-tertiary: #E0E7FF;       /* Soft Indigo for differentiation */

/* Structure */
--border-main: #000000;       /* Pure Black */
--shadow-main: #000000;       /* Pure Black */

/* Content */
--text-primary: #000000;      /* Pure Black */
--text-secondary: #404040;    /* Dark Gray */

/* Accents (High Saturation) */
--accent-main: #5C7CFA;       /* Vivid Blue */
--accent-success: #20E070;    /* Neo Green */
--accent-warning: #FFD43B;    /*Construction Yellow */
--accent-error: #FF6B6B;      /* Hot Red */

/* Interactive */
--hover-overlay: rgba(0,0,0, 0.05);
```

### Palette (Dark Mode - "Terminal")

```css
/* Base Canvas */
--bg-primary: #111111;        /* Near Black */
--bg-secondary: #1A1A1A;      /* Dark Gray */
--bg-tertiary: #2C2C2C;       /* Lighter Gray */

/* Structure */
--border-main: #FFFFFF;       /* Pure White Borders */
--shadow-main: #5C7CFA;       /* Blue Shadows for glow effect */

/* Content */
--text-primary: #FFFFFF;      /* Pure White */
--text-secondary: #AAAAAA;    /* Light Gray */
```

---

## Typography

### Font Stack

- **Headings**: 'JetBrains Mono', 'Fira Code', monospace (Technical, raw)
- **Body**: 'Inter', 'Pretendard', sans-serif (Legible, neutral)

```css
--font-heading: 'JetBrains Mono', monospace;
--font-body: 'Pretendard', sans-serif;
```

---

## Component Patterns

### The "Hard" Card

```css
.card {
  background: var(--bg-primary);
  border: 3px solid var(--border-main);
  box-shadow: 4px 4px 0px 0px var(--shadow-main);
  border-radius: 4px; /* Minimal rounding */
}
```

### The "Block" Button

```css
.btn-primary {
  background: var(--accent-main);
  color: #FFFFFF;
  border: 2px solid var(--border-main);
  box-shadow: 4px 4px 0px 0px var(--shadow-main);
  font-family: var(--font-heading);
  font-weight: 700;
  transition: all 0.1s;
}

.btn-primary:active {
  transform: translate(2px, 2px);
  box-shadow: 2px 2px 0px 0px var(--shadow-main);
}
```

### Status Badges

High contrast, black text on colored background, thick borders.

- **Success**: Black text on Neon Green (`#20E070`) + Black Border
- **Error**: Black text on Hot Red (`#FF6B6B`) + Black Border

---

## Layout Principles

- **Grid**: Modular, rigid grids. Lines may be visible.
- **Spacing**: Tighter, more compact than minimalism. Information density is higher.
- **Separators**: Thick black lines (`3px solid #000`) separate sections.

---

## Implementation Checklist

- [ ] Update `src/index.css` with Neo-Brutalist variables & Tailwind config.
- [ ] Refactor `App.tsx` shell to use thick borders.
- [ ] Update `DashboardView` cards to "Hard Card" style.
- [ ] Update Buttons to "Block Button" style.
