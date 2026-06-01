'use client';

import { useState } from 'react';
import { setSecret } from '@/lib/api';

export default function LoginPage() {
  const [secret, setSecretValue] = useState('');
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSecret(secret.trim());
    try {
      const base = process.env.NEXT_PUBLIC_API_BASE ?? '';
      const res = await fetch(`${base}/admin/api/dashboard`, {
        headers: { 'X-Trigger-Secret': secret.trim() },
      });
      if (!res.ok) {
        setError('Geçersiz secret');
        return;
      }
      window.location.href = '/admin/';
    } catch {
      setError('Bağlantı hatası');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-xl"
      >
        <h1 className="mb-1 text-xl font-semibold">coin-bot Admin</h1>
        <p className="mb-6 text-sm text-slate-400">TRIGGER_SECRET ile giriş</p>
        <label className="mb-2 block text-sm text-slate-300">Secret</label>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecretValue(e.target.value)}
          className="mb-4 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          autoComplete="current-password"
        />
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          className="w-full rounded-lg bg-emerald-600 py-2 text-sm font-medium hover:bg-emerald-500"
        >
          Giriş
        </button>
      </form>
    </div>
  );
}
