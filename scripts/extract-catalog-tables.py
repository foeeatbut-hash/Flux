"""Сохраняет кандидаты ячеек без догадок и без отметки verified.

Запуск из корня репозитория: python scripts/extract-catalog-tables.py
Зависимость: PyMuPDF. Вход — три неизменённых PDF в public/catalog-documents.
"""
import json
import pathlib
import re
import fitz

root = pathlib.Path(__file__).resolve().parent.parent
data_root = root / 'catalog/packs/source-data'
osa = json.loads((data_root / 'osa.json').read_text())
valves = json.loads((data_root / 'valves.json').read_text())
columns = [
    ('curve', 'Номер кривой', '', 'input'), ('wheelMod', 'Модификация колеса', '', 'input'),
    ('wheelIndex', 'Индекс колеса', '', 'input'), ('nominalPower', 'Номинальная мощность', 'кВт', 'output'),
    ('motorIndex', 'Индекс мощности двигателя', '', 'input'), ('motorFrame', 'Габарит ЭД', '', 'output'),
    ('current380', 'Ток при 380 В', 'А', 'output'), ('length01', 'L корпуса 01', 'мм', 'output'),
    ('lengthEx01', 'L Ex корпуса 01', 'мм', 'output'), ('length02', 'L корпуса 02', 'мм', 'output'),
    ('length1Max02', 'L1 max корпуса 02', 'мм', 'output'), ('length1ExMax02', 'L1 Ex max корпуса 02', 'мм', 'output'),
    ('mass01', 'Масса корпуса 01', 'кг', 'output'), ('mass02', 'Масса корпуса 02', 'кг', 'output'),
]
tables = []
for number in range(13, 35):
    page = osa['pages'][number - 1]
    raw = page['text']
    size = re.search(r'300/301-(\d{3})', raw)[1]
    poles = re.search(r'(\d)\s*полюс', raw, re.I)[1]
    rows = []
    for line in raw.splitlines():
        if not re.match(r'^\s*\d+\s+[А-ЯA-Z]\s+\d+\s+[\d,]+\s+\d{5}', line):
            continue
        values = line.split()
        if len(values) != len(columns):
            print('На проверку:', number, line)
            continue
        rows.append({'id': f'osa-{number}-{values[0]}', 'values': {'fanSize': size, 'poles': poles, **dict(zip([c[0] for c in columns], values))}, 'verified': False, 'source': page['source']})
    tables.append({'id': f'osa-performance-{size}-{poles}', 'title': f'ОСА 300/301-{size}, {poles} полюса: характеристики, размеры и масса', 'columns': [
        {'key': 'fanSize', 'label': 'Типоразмер', 'role': 'input'}, {'key': 'poles', 'label': 'Число полюсов', 'role': 'input'},
    ] + [{'key': key, 'label': label, 'role': role, **({'unit': unit} if unit else {})} for key, label, unit, role in columns],
        'rows': rows, 'source': page['source'], 'notes': [line.strip() for line in raw.splitlines() if re.match(r'^\s*\d\)', line)]})

for key, data, numbers in [('osa', osa, range(35, 49)), ('valves', valves, range(8, 115))]:
    document = fitz.open(root / f'public/catalog-documents/{key}.pdf')
    for number in numbers:
        for index, table in enumerate(document[number - 1].find_tables().tables):
            if table.col_count < 2 or table.row_count < 2:
                continue
            matrix = table.extract()
            tables.append({'id': f'{key}-candidate-{number}-{index}', 'title': f"{data['pages'][number - 1]['title']} · таблица {index + 1}",
                'columns': [{'key': f'c{k}', 'label': str(k + 1), 'role': 'output'} for k in range(table.col_count)],
                'rows': [{'id': f'{key}-{number}-{index}-{row_number}', 'values': {f'c{k}': value for k, value in enumerate(row)}, 'verified': False, 'source': data['pages'][number - 1]['source']} for row_number, row in enumerate(matrix)],
                'source': data['pages'][number - 1]['source'], 'review': 'Сверить заголовки, объединения, сноски, входные оси и единицы по оригиналу.'})

(data_root / 'table-candidates.json').write_text(json.dumps(tables, ensure_ascii=False, indent=1) + '\n')
print('Таблиц:', len(tables), 'строк характеристик ОСА:', sum(len(t['rows']) for t in tables if t['id'].startswith('osa-performance')))
