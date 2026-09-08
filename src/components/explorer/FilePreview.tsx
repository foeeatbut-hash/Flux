/**
 * Предпросмотр файла в правой полосе Проводника.
 *
 * Показывает то, что можно показать без открытия программы: картинку, текст,
 * первую страницу ПДФ. Всё остальное — значок типа и честная надпись, а не
 * пустой прямоугольник: человек должен понимать, что смотреть тут нечего, а
 * не думать, что не загрузилось.
 *
 * Байты берутся по одному файлу и только для того, который человек выбрал.
 * Раньше содержимое приезжало вместе со СПИСКОМ — то есть Проводник тащил
 * десятки мегабайт при каждом обновлении дерева, чтобы показать одну картинку.
 * А с тех пор как содержимое лежит кусками, поля `content` у файла и вовсе нет.
 *
 * Вынесено из Explorer: экран и без того велик, а разбор «чем это показать»
 * самодостаточен и меняется отдельно от списка файлов.
 */
import React from 'react';
import { fileDataUrl, fileText } from '../../lib/fileBytes';
import { faceOf, typeLabel } from '../../lib/fileTypes';

/** Что показывать: картинку, текст, ПДФ — или только значок */
const MIME: Record<string, string> = {
  image: 'application/octet-stream',
  pdf: 'application/pdf',
};

export default function FilePreview({ item, icon }: {
  item: { id: string; name: string; type?: string };
  /** Значок типа: его считает сам Проводник по своим правилам */
  icon: React.ReactNode;
}) {
  const name = item.name || '';
  const face = faceOf(name);
  const kind = face === 'image' ? 'image' : face === 'pdf' ? 'pdf' : (face === 'plain' || face === 'sheet') && /\.(txt|md|json|csv)$/i.test(name) ? 'text' : '';

  const [url, setUrl] = React.useState('');
  const [text, setText] = React.useState('');
  const [failed, setFailed] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    setUrl(''); setText(''); setFailed('');
    if (!kind || !item.id) return;
    (async () => {
      try {
        if (kind === 'text') {
          const t = await fileText(item.id);
          if (alive) setText(t);
        } else {
          const u = await fileDataUrl(item.id, MIME[kind] || 'application/octet-stream');
          if (alive) setUrl(u);
        }
      } catch (e: any) {
        if (alive) setFailed(String(e?.message || 'не удалось прочитать файл'));
      }
    })();
    return () => { alive = false; };
  }, [item.id, kind]);

  return (
    <div className="flex-1 flex items-center justify-center min-h-[240px] max-h-[300px] bg-white dark:bg-dark-panel
                    border border-slate-200 dark:border-dark-border rounded mb-4 overflow-hidden relative">
      {kind === 'image' && url ? (
        <img src={url} alt={name} className="max-w-full max-h-full object-contain" />
      ) : kind === 'text' && text ? (
        // Текст декодируем сами: iframe с data:text без charset давал кракозябры
        <pre className="w-full h-full overflow-auto text-left text-xs leading-relaxed p-3
                        text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words font-mono">
          {text}
        </pre>
      ) : kind === 'pdf' && url ? (
        // Пустой sandbox ломал встроенный просмотр ПДФ — оставляем скрипты
        <iframe src={url} className="w-full h-full border-0 bg-white dark:bg-dark-panel"
          title={name} sandbox="allow-scripts allow-same-origin" />
      ) : (
        <div className="text-center text-slate-400 flex flex-col items-center px-4">
          {icon}
          <span className="text-xs">{failed || typeLabel(name) || item.type || 'Файл'}</span>
        </div>
      )}
    </div>
  );
}
