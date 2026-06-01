import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'coin-bot Admin',
  description: 'Binance sniper bot yönetim paneli',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
