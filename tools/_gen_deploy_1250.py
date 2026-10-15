# -*- coding: utf-8 -*-
"""由 _deploy_1249.sh 生成 _deploy_1250.sh（改版本号与说明文件名）"""
s = open('tools/_deploy_1249.sh', encoding='utf-8').read()
s = (s.replace('1.2.49', '1.2.50')
      .replace('_readme_1249.txt', '_readme_1250.txt')
      .replace('使用说明-1.2.49.txt', '使用说明-1.2.50.txt')
      .replace('v1.2.49 部署', 'v1.2.50 部署'))
open('tools/_deploy_1250.sh', 'w', encoding='utf-8', newline='\n').write(s)
print('已生成 tools/_deploy_1250.sh')
