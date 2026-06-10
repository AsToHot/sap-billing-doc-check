-- 排除已开票数据：通过 VBRK + VBRP 查询已开票的行项目
-- 原逻辑中关联 ZTSD018I，此处改为直接查标准表

SELECT
  vbrp.vgbel,
  vbrp.vgpos
FROM vbrp
INNER JOIN vbrk ON vbrk.vbeln = vbrp.vbeln
WHERE vbrk.sfakn = ''
  AND vbrk.fksto = ''
  AND vbrk.fkart NOT IN ('ZIV1', 'ZIV2', 'ZIG1')
  -- 如需限定特定交货单/订单，添加：
  -- AND vbrp.vgbel IN @s_vbeln_js
ORDER BY vbrp.vgbel, vbrp.vgpos
