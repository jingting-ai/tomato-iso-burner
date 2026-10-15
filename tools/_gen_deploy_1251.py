# -*- coding: utf-8 -*-
"""由 _deploy_1250.sh 生成 _deploy_1251.sh"""
s = open('tools/_deploy_1250.sh', encoding='utf-8').read()
s = (s.replace('1.2.50', '1.2.51')
      .replace('_readme_1250.txt', '_readme_1251.txt')
      .replace('使用说明-1.2.50.txt', '使用说明-1.2.51.txt')
      .replace('v1.2.50 部署', 'v1.2.51 部署'))
# 顺带补一条：还原脚本里卷标/图标的标记
if '番茄U盘' not in s:
    s = s.replace(
        "  console.log('repair.ps1 已随包               :', rp.includes('-List') && rp.includes('Get-BuiltInSet'));",
        "  console.log('repair.ps1 已随包               :', rp.includes('-List') && rp.includes('Get-BuiltInSet'));\n"
        "  console.log('repair.ps1 默认卷标番茄U盘      :', rp.includes('番茄U盘'));")
open('tools/_deploy_1251.sh', 'w', encoding='utf-8', newline='\n').write(s)
print('已生成 tools/_deploy_1251.sh')
