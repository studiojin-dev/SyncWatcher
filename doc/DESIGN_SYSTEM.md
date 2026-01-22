# SyncWatcher Look & Feel Design System

## "Invisible but Powerful" - Airy Postmodern Minimalism

---

## Design Philosophy

### Core Concept: The Disappearing Interface

SyncWatcher's design embodies a paradox: **maximum functionality through minimal presence**. The interface should feel like breathing—essential but unnoticed. Every pixel exists to serve the user's workflow, never to announce itself.

This is not minimalism as absence, but minimalism as **precision**. Each element is refined until only its essence remains. Typography whispers. Colors recede to tints and tones. Borders dissolve to suggestions. The interface becomes a translucent membrane between intention and action, so refined it approaches invisibility.

### Spatial Philosophy: Ma (間)

We embrace the Japanese concept of ma—the aesthetic appreciation of negative space as an active element. Space is not empty; it is **potential**. It gives the interface room to breathe, the user's mind room to think, and information room to resonate.

Generous margins are not wasteful—they are essential. They create rhythm, establish hierarchy without weight, and let each element exist in its own atmosphere. The space between elements is as carefully composed as the elements themselves.

### Material Language: Ghost Glass

Our visual language borrows from architectural glass: **present but transparent, structural but ethereal**. Elements should feel like frosted panes floating in space—you sense their presence through subtle refractions, edge treatments, and tonal shifts rather than heavy borders or shadows.

Depth comes from layering translucencies, not from skeuomorphic shadows. A card hovers not through drop-shadow but through a barely-perceptible luminosity at its edges, a whisper-thin border at 3% opacity, a background tint one shade lighter than its canvas.

### Color as Atmosphere

Color is **tonal, not chromatic**. We work in a world of whites, grays, and the subtlest blue-gray accents—colors so desaturated they approach grayscale but retain enough warmth to feel human, not sterile.

Accent colors appear as **tints** rather than saturated hues. A successful sync isn't bright green—it's a 97% opacity near-white with 3% green. An error isn't red—it's a barely-perceptible coral warmth. Color should be felt as atmosphere, not seen as decoration.

### Typography as Architecture

Text is set small, tight, and geometric. We favor ultra-thin weights (200-300) in sans-serif typefaces with geometric purity—letterforms as refined as the overall aesthetic. Size compensates with generous line-height (1.7-2.0) and letter-spacing, creating an airy, spacious reading experience despite compact size.

Hierarchies emerge through **size contrast** and **weight variation** rather than color. A heading might be 13px at weight 400 while body text is 11px at weight 300. The differences are subtle but sufficient. We trust the user's intelligence to perceive structure without heavy-handed visual cues.

### Motion as Breath

Animations are **micro and organic**—60-120ms transitions with ease-in-out curves. Nothing snaps; everything flows. A card highlight doesn't jump to attention; it gently glows from within. A menu doesn't slam open; it unfolds with the timing of a deep breath.

We avoid elaborate choreography. Instead, we create **ambient responsiveness**: hover states that emerge gradually, focus rings that pulse gently, page transitions that fade rather than slide. Motion should feel like the interface is alive and responsive, not performative.

---

## Color System

### Light Mode

```css
/* Base Canvas */
--bg-primary: #FAFBFC;        /* Whisper white */
--bg-secondary: #F5F6F8;      /* Lighter ghost gray */
--bg-tertiary: #ECEEF1;       /* Subtle depth */

/* Content */
--text-primary: #2A2E35;      /* Deep charcoal, 85% opacity */
--text-secondary: #6B7280;    /* Medium gray */
--text-tertiary: #9CA3AF;     /* Light gray, subtle */

/* Accents */
--accent-blue: #E8EEFF;       /* Barely-there blue */
--accent-blue-subtle: #F5F7FF;/* Even lighter */
--accent-border: #E5E7EB;     /* Ghost borders, 5% opacity */

/* Status Tints */
--status-success-bg: #F0FDF4; /* Near-white with 3% green */
--status-success-text: #10B981; /* Emerald, only for icons */
--status-error-bg: #FEF2F2;   /* Near-white with 3% red */
--status-error-text: #EF4444; /* Coral, only for icons */
--status-warning-bg: #FFFBEB; /* Near-white with 3% amber */
--status-warning-text: #F59E0B; /* Amber, only for icons */

/* Interactive */
--hover-overlay: rgba(0, 0, 0, 0.02); /* Barely visible hover */
--active-overlay: rgba(0, 0, 0, 0.04); /* Slightly more present */
--focus-ring: rgba(99, 102, 241, 0.1); /* Subtle indigo glow */
```

### Dark Mode

```css
/* Base Canvas */
--bg-primary: #0F1115;        /* Deep void */
--bg-secondary: #1A1D24;      /* Slightly elevated */
--bg-tertiary: #24272F;       /* Card surface */

/* Content */
--text-primary: #E5E7EB;      /* Soft white, 90% opacity */
--text-secondary: #9CA3AF;    /* Medium gray */
--text-tertiary: #6B7280;     /* Subtle gray */

/* Accents */
--accent-blue: #1E293B;       /* Very dark blue-gray */
--accent-blue-subtle: #171E2A;/* Even darker */
--accent-border: #2D3139;     /* Ghost borders */

/* Status Tints - Dark */
--status-success-bg: #022C22;  /* Near-black with green tint */
--status-success-text: #34D399; /* Lighter emerald */
--status-error-bg: #2C0A0A;    /* Near-black with red tint */
--status-error-text: #F87171;  /* Lighter coral */
--status-warning-bg: #2C1810;  /* Near-black with amber tint */
--status-warning-text: #FBBF24; /* Lighter amber */

/* Interactive - Dark */
--hover-overlay: rgba(255, 255, 255, 0.03); /* Subtle lift */
--active-overlay: rgba(255, 255, 255, 0.06);
--focus-ring: rgba(139, 92, 246, 0.15); /* Violet glow */
```

---

## Typography

### Font Stack (Copyright Safe & Optimized)

```css
/* Primary: Ultra-thin geometric sans. Optimized for Korean & Cross-platform */
--font-primary: 'Pretendard Variable', 'Pretendard', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', sans-serif;

/* Monospace: For file paths and technical data */
--font-mono: 'JetBrains Mono', 'SF Mono', 'Cascadia Code', 'Consolas', monospace;

/* Weights */
--weight-thin: 200;      /* For large headings */
--weight-light: 300;     /* Body text default */
--weight-normal: 400;    /* Emphasis */
--weight-medium: 500;    /* Strong emphasis */
```

### Type Scale

```css
/* Hierarchy through minimal size variation */
--text-xs: 10px;    /* Metadata, timestamps */
--text-sm: 11px;    /* Body text default */
--text-base: 13px;  /* Emphasized body */
--text-lg: 15px;    /* Subheadings */
--text-xl: 18px;    /* Section titles */
--text-2xl: 24px;   /* Page titles (rare) */

/* Line Heights - Generous */
--leading-tight: 1.4;
--leading-normal: 1.7;
--leading-relaxed: 2.0;

/* Letter Spacing */
--tracking-tight: -0.01em;
--tracking-normal: 0;
--tracking-wide: 0.02em;   /* For all-caps labels */
```

### Usage Guidelines

- **Default body**: 11px, weight 300, line-height 1.7
- **Headings**: 13-15px, weight 400, line-height 1.4
- **Labels**: 10px, weight 400, uppercase, tracking-wide, text-secondary
- **Monospace**: File paths, byte counts, timestamps

### Font Licensing & Copyright

SyncWatcher uses a "Safety First" font strategy. All primary fonts are either Open Source (OFL) or pre-installed System Fonts, ensuring zero licensing costs and zero legal risks for commercial use.

- **Pretendard / Inter / JetBrains Mono**: Licensed under SIL Open Font License (OFL). 100% free to bundle, modify, and distribute with the application.
- **SF Pro / SF Mono / Consolas**: System fonts. Legally safe to reference via CSS `font-family` name; no font files are embedded in the app to avoid redistribution restrictions.
- **Pretendard Recommendation**: Chosen for its perfect harmony with SF Pro and superior Korean typography support.

---

## Spacing System

### Base Unit: 4px

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-10: 40px;
--space-12: 48px;
--space-16: 64px;
--space-20: 80px;
```

### Usage Patterns

- **Component padding**: 12-16px (space-3 to space-4)
- **Card spacing**: 16-24px internal padding
- **Section gaps**: 32-48px vertical rhythm
- **Page margins**: 40-64px generous breathing room
- **Micro spacing**: 4-8px between related elements

**Key principle**: When in doubt, add more space. Density creates visual noise; spaciousness creates clarity.

---

## Component Patterns

### Cards

```css
.card {
  background: var(--bg-tertiary);
  border: 1px solid color-mix(in srgb, var(--accent-border) 5%, transparent);
  border-radius: 8px;
  padding: var(--space-4) var(--space-5);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02),
              0 1px 2px rgba(0, 0, 0, 0.01);
  transition: all 120ms ease-in-out;
}

.card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.03),
              0 1px 4px rgba(0, 0, 0, 0.02);
  transform: translateY(-1px);
}
```

### Buttons

```css
/* Ghost button - primary pattern */
.btn-ghost {
  background: transparent;
  border: 1px solid var(--accent-border);
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-weight: var(--weight-light);
  padding: var(--space-2) var(--space-4);
  border-radius: 6px;
  transition: all 100ms ease-out;
}

.btn-ghost:hover {
  background: var(--hover-overlay);
  border-color: var(--text-tertiary);
}

/* Rarely used - only for critical actions */
.btn-primary {
  background: color-mix(in srgb, var(--accent-blue) 10%, transparent);
  color: var(--text-primary);
  border: 1px solid var(--accent-border);
  /* Same padding/transitions */
}
```

### Progress Indicators

```css
.progress-bar {
  height: 2px; /* Hair-thin */
  background: var(--bg-tertiary);
  border-radius: 1px;
  overflow: hidden;
  position: relative;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg,
    color-mix(in srgb, var(--accent-blue) 20%, transparent),
    color-mix(in srgb, var(--accent-blue) 40%, transparent)
  );
  transition: width 200ms ease-out;
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent-blue) 30%, transparent);
}
```

### Navigation Tabs

```css
.nav-tabs {
  display: flex;
  gap: var(--space-1);
  border-bottom: 1px solid var(--accent-border);
}

.nav-tab {
  padding: var(--space-3) var(--space-4);
  font-size: var(--text-sm);
  font-weight: var(--weight-light);
  color: var(--text-secondary);
  border-bottom: 2px solid transparent;
  transition: all 100ms ease-out;
}

.nav-tab.active {
  color: var(--text-primary);
  border-bottom-color: color-mix(in srgb, var(--text-primary) 40%, transparent);
}

.nav-tab:hover:not(.active) {
  color: var(--text-primary);
  background: var(--hover-overlay);
}
```

---

## Layout Principles

### Sidebar + Main Content

```
┌──────────────────────────────────┐
│ ┌─────┐                          │
│ │     │  Main Content Area       │
│ │ Nav │  (Generous margins)      │
│ │     │                          │
│ │     │  Content flows here      │
│ │     │  with 64px margins       │
│ └─────┘                          │
└──────────────────────────────────┘

Sidebar: 200-240px, transparent bg
Main: flex-1, 64px horizontal padding
```

### Card Grid (Bento Layout)

```css
.bento-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: var(--space-6); /* 24px */
  padding: var(--space-8); /* 32px */
}
```

### Vertical Rhythm

- Section title: `margin-bottom: space-3` (12px)
- Between cards: `space-6` (24px)
- Between sections: `space-10` to `space-12` (40-48px)
- Page padding: `space-16` (64px)

---

## Animation Presets

```css
/* Micro-transitions */
--transition-fast: 80ms ease-out;
--transition-base: 120ms ease-in-out;
--transition-slow: 200ms ease-in-out;

/* Easing curves */
--ease-out: cubic-bezier(0.33, 1, 0.68, 1);
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);

/* Apply to interactive elements */
.interactive {
  transition: all var(--transition-base);
}

.hover-lift:hover {
  transform: translateY(-2px);
  transition: transform var(--transition-fast);
}

.fade-in {
  animation: fadeIn var(--transition-slow) var(--ease-in-out);
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
```

---

## Dark Mode Implementation

### Strategy: CSS Custom Properties

All colors are defined as CSS variables. Dark mode switches the root variables:

```css
/* Auto-detect user preference */
@media (prefers-color-scheme: dark) {
  :root {
    /* Swap to dark palette */
    --bg-primary: #0F1115;
    --text-primary: #E5E7EB;
    /* ... all colors ... */
  }
}

/* Manual toggle via data attribute */
[data-theme="dark"] {
  /* Same dark palette */
}

[data-theme="light"] {
  /* Light palette (default) */
}
```

### Transition Smoothness

```css
:root {
  transition: background-color 150ms ease-in-out,
              color 150ms ease-in-out;
}
```

---

## Implementation Checklist

### Phase 5 UI Components

- [ ] **App Shell**: Sidebar + main content layout
- [ ] **Sidebar**: Navigation tabs with hover states
- [ ] **Dashboard**: Bento grid for volume cards
- [ ] **Volume Card**: Ghost-glass aesthetic, minimal text
- [ ] **Sync Progress**: Hair-thin progress bar with glow
- [ ] **Sync Tasks List**: Transparent cards, subtle dividers
- [ ] **Activity Log**: Chronological list, status tints
- [ ] **Settings Panel**: Dropdown menus, toggle switches
- [ ] **Dark Mode Toggle**: Smooth theme transition
- [ ] **Error Toasts**: Floating notifications, auto-dismiss

### Technical Requirements

- Use CSS custom properties for all colors/spacing
- Implement `prefers-color-scheme` media query
- Add manual theme toggle stored in localStorage
- Set default font-size to 87.5% (14px → 11px base)
- Use `color-mix()` for all tints (95+ browser support)
- Ensure AAA color contrast for text (4.5:1 minimum)

---

## References & Inspiration

- **Swiss Design**: Grid systems, typography hierarchy
- **Japanese Ma**: Negative space as active element
- **Glass Morphism**: Translucent layers, subtle depth
- **Dieter Rams**: "Less but better" design philosophy
- **Linear app**: Reference for file sync UI patterns

---

**Next Steps**: Implement this design system in `src/App.tsx` and component files. Start with the app shell and navigation, then progressively add Dashboard → Sync Tasks → Activity Log → Settings.
