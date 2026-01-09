/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{html,ts,tsx}",
    "./index.html"
  ],
  // 使用 selector 策略，基于 data-color-mode 属性切换深色模式
  darkMode: ['selector', '[data-color-mode="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"LXGW WenKai Screen"', 'sans-serif'],
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
