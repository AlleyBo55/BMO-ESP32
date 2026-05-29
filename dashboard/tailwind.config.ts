import type { Config } from 'tailwindcss';

/**
 * Tailwind CSS v3 configuration.
 *
 * Dark-mode is the default (the root layout sets `bg-zinc-950`); we still
 * enable `class` strategy so future light-mode toggles are possible without
 * rewriting markup.
 */
const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
