/**
 * «Моя подпись» — раздел Настроек.
 *
 * Подпись жила значком в подвале Пуска и открывалась окном поверх всего.
 * Место было случайным: Пуск — это запуск программ, а подпись — настройка
 * человека, такая же, как тема или уведомления. Найти её там можно было
 * только зная, что она там есть.
 *
 * Сам редактор не переписан — он взят как есть и показан внутри страницы
 * (`inline`). Второго такого редактора заводить нельзя: подпись правит ещё и
 * администратор из списка сотрудников, и разойтись эти два места не должны.
 */
import React from 'react';
import { useStore } from '../../store/store';
import { useToastStore } from '../../store/toastStore';

const SignatureEditor = React.lazy(() => import('../SignatureEditor'));

export default function SignatureSection() {
  const user = useStore((s) => s.user);
  const { addToast } = useToastStore();

  if (!user) return null;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-bold text-slate-800 dark:text-white">Моя подпись</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          Ею подписываются поля «Разработал», «Проверил» и «Утвердил» — и в
          документе на экране, и в файле, который уходит заказчику.
        </p>
      </div>

      <React.Suspense fallback={<div className="text-xs text-slate-400">Загрузка редактора…</div>}>
        <SignatureEditor
          userId={user.id}
          userName={user.name || user.symbol}
          nameParts={{
            lastName: (user as any).lastName,
            firstName: (user as any).firstName,
            middleName: (user as any).middleName,
            name: user.name,
          }}
          canEdit
          inline
          onSaved={() => addToast('Подпись сохранена', 'success')}
          onClose={() => { /* внутри страницы закрывать нечего */ }}
        />
      </React.Suspense>
    </div>
  );
}
