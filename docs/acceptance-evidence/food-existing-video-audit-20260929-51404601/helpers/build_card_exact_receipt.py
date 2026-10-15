from __future__ import annotations
import hashlib,json
from pathlib import Path
AUDIT=Path(__file__).resolve().parent
RUN=Path(r'D:\vac\f3\w\video\runs\20260929\f3\.videoautocut\runs\run_175e3315e0624f028eba293d66a9dece')
oracle=json.loads((AUDIT/'receipts'/'xlsx-card-oracle.json').read_text(encoding='utf-8'))
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
rows=[]
for item in oracle['shots']:
    shot=item['shot']; expected='\n'.join(item['expected_visible_lines'])
    template=RUN/'final_clips'/'packaging'/f'{shot:04d}_final'/'template.json'
    if template.exists():
        j=json.loads(template.read_text(encoding='utf-8')); actual=j['content']
        rows.append({'shot':shot,'expected':expected,'actual':actual,'exact_codepoint_equal':actual==expected,'template':str(template),'template_sha256':sha(template),'pages':j.get('pages'),'template_source':j.get('template_source'),'card_layout':j.get('card_layout')})
    else:
        rows.append({'shot':shot,'expected_card':item['card_expected'],'packaging_directory_exists':template.parent.exists(),'no_card_exact':not item['card_expected'] and not template.parent.exists()})
out={'schema':'food-card-exact/v1','xlsx_sha256':oracle['xlsx_sha256'],'comparisons':rows,'all_pass':all(x.get('exact_codepoint_equal',x.get('no_card_exact',False)) for x in rows),'note':'Labels 大字：/副行：/参数卡： are excluded per contract. Card hint 参数列表 is not expected visible content.'}
(AUDIT/'receipts'/'card-exact.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'all_pass':out['all_pass'],'shots':[{'shot':x['shot'],'pass':x.get('exact_codepoint_equal',x.get('no_card_exact'))} for x in rows]},ensure_ascii=False))
