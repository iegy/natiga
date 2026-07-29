"""
سكريبت بناء بيانات موقع الاستعلام عن نتيجة الثانوية العامة.

الاستخدام:
    python3 build_data.py المسار/لملف/النتيجة.xlsx

- بياخد ملف إكسل فيه ٤ أعمدة بالظبط بنفس الترتيب ده:
  seating_no | arabic_name | total_degree | student_case_desc
- لو عمود "الحالة" فيه نص مختلف عن الأربع حالات المعروفة (STATUS_MAP
  تحت) هيوقف بخطأ واضح عشان تضيف الحالة الجديدة يدويًا.
- بيكتب كل ملفات البيانات جوه مجلد docs/data بجانب السكريبت ده — يعني
  لو عايز تبني نتيجة الدور الثاني، شغّل السكريبت على ملف الدور الثاني
  وهو هيدهس (overwrite) البيانات القديمة في docs/data تلقائيًا.

بياخد حوالي دقيقة على ملف ~٩٠٠ ألف صف.
"""
import sys
import re
import json
import os
from collections import defaultdict

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, 'docs')
SEAT_DIR = os.path.join(DOCS, 'data', 'seat')
NAME_DIR = os.path.join(DOCS, 'data', 'name')

# لو ظهرت حالة جديدة (زي نتيجة دور ثان فعلي) ضيفها هنا برقم كود جديد.
STATUS_MAP = {
    'ناجح دور أول': 0,
    'دور ثان': 1,
    'راسب دور أول': 2,
    'غياب كلى دور أول': 3,
}

THRESHOLD = 10000   # أقصى عدد سجلات في ملف اسم واحد قبل ما نقسّمه أكتر
MAXDEPTH = 20        # أقصى عمق لشجرة البادئات


def normalize(s):
    """توحيد الاسم للمقارنة: شكل الهمزات، الألف المقصورة، التاء المربوطة،
    والتشكيل. لازم يفضل مطابق تمامًا لدالة normalize() في assets/app.js"""
    s = str(s)
    s = re.sub(r'[\u064B-\u0652\u0670\u0640]', '', s)  # تشكيل + تطويل
    s = re.sub(r'[إأآٱ]', 'ا', s)
    s = s.replace('ى', 'ي')
    s = s.replace('ة', 'ه')
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def main():
    if len(sys.argv) != 2:
        print('الاستخدام: python3 build_data.py path/to/result.xlsx')
        sys.exit(1)
    xlsx_path = sys.argv[1]

    os.makedirs(SEAT_DIR, exist_ok=True)
    os.makedirs(NAME_DIR, exist_ok=True)
    # نظّف بيانات قديمة قبل ما نكتب الجديدة
    for d in (SEAT_DIR, NAME_DIR):
        for fn in os.listdir(d):
            os.remove(os.path.join(d, fn))

    print('بيقرا ملف الإكسل... (ممكن ياخد نص دقيقة لدقيقة)')
    df = pd.read_excel(xlsx_path, engine='openpyxl')
    expected_cols = ['seating_no', 'arabic_name', 'total_degree', 'student_case_desc']
    assert list(df.columns) == expected_cols, (
        f'أعمدة الملف مش زي المتوقع.\nمتوقع: {expected_cols}\nموجود: {list(df.columns)}'
    )

    df['student_case_desc'] = df.student_case_desc.str.strip()
    df['status_code'] = df.student_case_desc.map(STATUS_MAP)
    unmapped = df[df.status_code.isnull()].student_case_desc.unique()
    assert len(unmapped) == 0, (
        f'فيه حالات جديدة مش موجودة في STATUS_MAP: {list(unmapped)}\n'
        f'ضيفها في القاموس أول السكريبت وشغّله تاني.'
    )
    df['norm'] = df.arabic_name.map(normalize)

    # ---------- ملفات رقم الجلوس ----------
    print('بيبني ملفات رقم الجلوس...')
    df['seat_bucket'] = (df.seating_no // 1000) * 1000
    seat_count = 0
    for bucket, group in df.groupby('seat_bucket'):
        obj = {}
        for row in group.itertuples():
            offset = str(row.seating_no - bucket)
            obj[offset] = [row.arabic_name, row.total_degree, int(row.status_code)]
        path = os.path.join(SEAT_DIR, f'{bucket}.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
        seat_count += 1
    print('عدد ملفات رقم الجلوس:', seat_count)

    # ---------- شجرة بادئات الاسم ----------
    print('بيبني فهرس الاسم...')
    norms = df['norm'].to_dict()
    seatnos = df['seating_no'].to_dict()
    names = df['arabic_name'].to_dict()
    degrees = df['total_degree'].to_dict()
    statuses = df['status_code'].to_dict()

    shard_records = {}
    next_id = [0]

    def new_id():
        i = next_id[0]
        next_id[0] += 1
        return i

    def build(indices, prefix, node_out):
        if len(indices) <= THRESHOLD or len(prefix) >= MAXDEPTH:
            fid = new_id()
            node_out['f'] = fid
            node_out['n'] = len(indices)
            shard_records[fid] = indices
            return

        groups = defaultdict(list)
        terminal = []
        depth = len(prefix)
        for i in indices:
            n = norms[i]
            if len(n) <= depth:
                terminal.append(i)
            else:
                groups[n[depth]].append(i)

        if terminal:
            fid = new_id()
            node_out['t'] = fid
            node_out['tn'] = len(terminal)
            shard_records[fid] = terminal

        if groups:
            node_out['k'] = {}
            for ch, idxs in groups.items():
                child = {}
                node_out['k'][ch] = child
                build(idxs, prefix + ch, child)

    trie_root = {}
    build(list(df.index), '', trie_root)

    print('عدد ملفات الاسم:', len(shard_records))
    for fid, indices in shard_records.items():
        arr = [[int(seatnos[i]), names[i], degrees[i], int(statuses[i])] for i in indices]
        path = os.path.join(NAME_DIR, f'{fid}.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(arr, f, ensure_ascii=False, separators=(',', ':'))

    with open(os.path.join(DOCS, 'data', 'trie.json'), 'w', encoding='utf-8') as f:
        json.dump(trie_root, f, ensure_ascii=False, separators=(',', ':'))

    # ---------- meta.json ----------
    status_labels = {v: k for k, v in STATUS_MAP.items()}
    meta = {
        'total': int(len(df)),
        'seatMin': int(df.seating_no.min()),
        'seatMax': int(df.seating_no.max()),
        'maxDegree': float(df.total_degree.max()),
        'statusLabels': status_labels,
        'seatShards': seat_count,
        'nameShards': len(shard_records),
    }
    with open(os.path.join(DOCS, 'data', 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, separators=(',', ':'))

    print('تم بنجاح')
    print(meta)


if __name__ == '__main__':
    main()
