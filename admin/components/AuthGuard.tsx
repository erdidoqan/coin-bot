'use client';

import { useEffect, useState } from 'react';
import { getSecret } from '@/lib/api';

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [ok, setOk] = useState(false);

  useEffect(() => {
    if (!getSecret()) {
      window.location.href = '/admin/login/';
      return;
    }
    setOk(true);
  }, []);

  if (!ok) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-400">
        Yükleniyor…
      </div>
    );
  }

  return <>{children}</>;
}
