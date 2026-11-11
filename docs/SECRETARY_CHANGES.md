# 秘书端 v1 改动说明

- 删除设置页面、导航及专用配置控件，业务页面整体风格不变。
- 云盘路径移至 native/secretary_config.py 的 CLOUD_EXCEL_PATH；前端路径表单及监听器移除。
- native/desktop.py 使用内置路径，忽略旧配置并拒绝 cloudExcel 配置写入。Excel 合并/备份与 OCR 算法不变。
- Mac 独立启动脚本及公共模型保留；原始源码不修改。
- 秘书端 v1 发布于 valentinaeea/contract-ocr-secretary 的 main；后续版本持续更新。
- 临时数据测试，不读取或迁移真实合同库。
