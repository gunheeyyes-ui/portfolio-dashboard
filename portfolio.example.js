// Sample holdings. Copy this file to portfolio.js and replace it with your
// own positions:
//
//   Copy-Item portfolio.example.js portfolio.js   # PowerShell
//   cp portfolio.example.js portfolio.js          # bash
//
// portfolio.js is gitignored because quantities and average prices are
// personal financial data; only this example is tracked.
export const portfolio = [
  { name: "삼성전자", code: "005930", qty: 10, avgPrice: 70000, fallbackPrice: 71000 },
  { name: "SK하이닉스", code: "000660", qty: 5, avgPrice: 200000, fallbackPrice: 210000 },
  { name: "NAVER", code: "035420", qty: 8, avgPrice: 220000, fallbackPrice: 225000 },
  { name: "현대차", code: "005380", qty: 12, avgPrice: 240000, fallbackPrice: 238000 },
  { name: "KODEX 200", code: "069500", qty: 100, avgPrice: 38000, fallbackPrice: 39000 }
];

// Theme groupings used by the 테마 노출 panel. Codes may repeat across themes.
export const themes = {
  semiconductor: ["005930", "000660"],
  energyPower: ["009830", "034020"],
  autoBattery: ["005380", "066570"],
  constructionShip: ["000720"],
  platform: ["035420", "035720"]
};
