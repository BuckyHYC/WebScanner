/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#0b0f14',
          900: '#10161d',
          800: '#161f29',
          700: '#1d2835',
          600: '#28374a',
        },
        accent: {
          DEFAULT: '#2f81f7',
          hover: '#4c94f8',
        },
      },
    },
  },
  plugins: [],
};
