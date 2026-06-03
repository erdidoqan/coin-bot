'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clearSecret } from '@/lib/api';

const links = [
  { href: '/', label: 'Dashboard' },
  { href: '/dip-reversal/', label: 'Dip Reversal' },
  { href: '/binance-pnl/', label: 'Binance PnL' },
  { href: '/market-data/', label: 'Market verisi' },
  { href: '/logs/', label: 'Olaylar' },
  { href: '/config/', label: 'Ayarlar' },
  { href: '/actions/', label: 'Aksiyonlar' },
];

const brandClass =
  'inline-flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-sm font-semibold tracking-wide text-amber-300 hover:bg-amber-500/15';

export function Nav() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [menuOpen]);

  const logout = () => {
    clearSecret();
    window.location.href = '/admin/login/';
  };

  const isActive = (href: string) => pathname === href || pathname === href.replace(/\/$/, '');

  const linkClass = (href: string) =>
    isActive(href) ? 'text-white' : 'text-slate-400 hover:text-white';

  return (
    <>
      <header className="border-b border-slate-800 bg-slate-900/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link href="/" className={brandClass}>
            <span aria-hidden className="h-2 w-2 rounded-full bg-amber-300" />
            <span>Binance Bot</span>
          </Link>

          <nav className="hidden items-center gap-4 text-sm md:flex">
            {links.map((l) => (
              <Link key={l.href} href={l.href} className={linkClass(l.href)}>
                {l.label}
              </Link>
            ))}
          </nav>

          <button
            type="button"
            onClick={logout}
            className="hidden text-sm text-slate-400 hover:text-red-400 md:block"
          >
            Çıkış
          </button>

          <button
            type="button"
            aria-expanded={menuOpen}
            aria-controls="mobile-nav-drawer"
            onClick={() => setMenuOpen((current) => !current)}
            className="inline-flex h-9 w-9 items-center justify-center rounded border border-slate-700 text-slate-200 hover:bg-slate-800 md:hidden"
          >
            <span className="sr-only">{menuOpen ? 'Menüyü kapat' : 'Menüyü aç'}</span>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
            >
              {menuOpen ? (
                <>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </>
              ) : (
                <>
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </>
              )}
            </svg>
          </button>
        </div>
      </header>

      {menuOpen && (
        <>
          <button
            type="button"
            aria-label="Menüyü kapat"
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            onClick={() => setMenuOpen(false)}
          />
          <aside
            id="mobile-nav-drawer"
            className="fixed right-0 top-0 z-50 flex h-full w-72 max-w-[90vw] flex-col border-l border-slate-800 bg-slate-950 md:hidden"
          >
            <div className="border-b border-slate-800 px-4 py-3">
              <Link href="/" className={brandClass}>
                <span aria-hidden className="h-2 w-2 rounded-full bg-amber-300" />
                <span>Binance Bot</span>
              </Link>
            </div>

            <nav className="flex-1 space-y-1 p-4 text-sm">
              {links.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`block rounded px-3 py-2 ${isActive(l.href) ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-900 hover:text-white'}`}
                >
                  {l.label}
                </Link>
              ))}
            </nav>

            <div className="border-t border-slate-800 p-4">
              <button
                type="button"
                onClick={logout}
                className="w-full rounded border border-slate-700 px-3 py-2 text-left text-sm text-slate-300 hover:border-red-900 hover:text-red-400"
              >
                Çıkış
              </button>
            </div>
          </aside>
        </>
      )}
    </>
  );
}
