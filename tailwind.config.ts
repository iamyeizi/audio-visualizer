import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1.5rem" },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
      },
      borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 2px)", sm: "calc(var(--radius) - 4px)" },
      keyframes: {
        shimmer: { "0%": { transform: "translateX(-100%)" }, "100%": { transform: "translateX(100%)" } },
        "drop-float": { "0%, 100%": { transform: "translateY(0) scale(1)" }, "50%": { transform: "translateY(-8px) scale(1.03)" } },
        "drop-ring": { "0%": { transform: "scale(0.85)", opacity: "0.55" }, "100%": { transform: "scale(1.45)", opacity: "0" } },
        "toast-in": { "0%": { transform: "translateX(110%)", opacity: "0" }, "100%": { transform: "translateX(0)", opacity: "1" } },
        "toast-out": { "0%": { transform: "translateX(0)", opacity: "1" }, "100%": { transform: "translateX(110%)", opacity: "0" } },
        "toast-swipe-out": { "0%": { transform: "translateX(var(--radix-toast-swipe-end-x))" }, "100%": { transform: "translateX(110%)" } },
      },
      animation: {
        shimmer: "shimmer 1.8s infinite",
        "drop-float": "drop-float 1.4s ease-in-out infinite",
        "drop-ring": "drop-ring 1.4s ease-out infinite",
        "toast-in": "toast-in 220ms ease-out",
        "toast-out": "toast-out 180ms ease-in forwards",
        "toast-swipe-out": "toast-swipe-out 160ms ease-out forwards",
      },
    },
  },
  plugins: [],
} satisfies Config;
