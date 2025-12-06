/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{html,ts,tsx}",
    "./index.html"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"LXGW WenKai"', 'sans-serif'],
      },
      colors: {
        canvas: '#F5F2E9',
        panel: '#EBE7D9',
        retro: {
          teal: '#4A8C8C',
          rust: '#C15B3E',
          olive: '#8B9A46',
          gold: '#B89C48',
          beige: '#EBE7D9',
          cream: '#F5F2E9',
          dark: '#44403C',
          muted: '#78716C'
        }
      }
    },
  },
  plugins: [],
}
