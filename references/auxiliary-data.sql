-- 辅助数据查询集合（标准表）
-- 在主查询后分批执行，用于组装展示数据

-- 1. 单据类别描述 (VBTYP)
SELECT dd07t.domvalue_l,
       dd07t.ddtext
FROM dd07t
WHERE dd07t.domname = 'VBTYP'
  AND dd07t.ddlanguage = @sy_langu
  AND dd07t.as4local = 'A'
ORDER BY dd07t.domvalue_l;

-- 2. 交货类型描述 (LFART)
SELECT tvlkt.lfart,
       tvlkt.vtext
FROM tvlkt
WHERE tvlkt.spras = @sy_langu
ORDER BY tvlkt.lfart;

-- 3. 销售组织描述
SELECT tvkot.vkorg,
       tvkot.vtext
FROM tvkot
WHERE tvkot.spras = @sy_langu
ORDER BY tvkot.vkorg;

-- 4. 客户全称 (BP 架构)
SELECT but000.partner,
       but000.name_org1,
       but000.name_org2,
       but000.name_org3,
       but000.name_org4
FROM but000
ORDER BY but000.partner;

-- 5. 客户经理 (PARVW='Z1')
SELECT knvp.kunnr,
       knvp.vkorg,
       knvp.kunn2 AS kunn1
FROM knvp
WHERE knvp.parvw = 'Z1'
ORDER BY knvp.kunnr, knvp.vkorg;

-- 6. 发货地址
SELECT vbpa.vbeln,
       vbpa.kunnr,
       adrc.street,
       adrc.str_suppl1,
       adrc.str_suppl2
FROM vbpa
LEFT JOIN adrc ON adrc.addrnumber = vbpa.adrnr
WHERE vbpa.posnr = '000000'
  AND vbpa.parvw = 'WE'
ORDER BY vbpa.vbeln;

-- 7. 订单单价 (PRCD_ELEMENTS)
SELECT vbap.vbeln,
       vbap.posnr,
       prcd.kschl,
       prcd.kbetr,
       prcd.kpein,
       CASE WHEN prcd.knumh IS NOT INITIAL THEN '1' ELSE '0' END AS knumh_flg
FROM prcd_elements AS prcd
INNER JOIN vbak ON vbak.knumv = prcd.knumv
INNER JOIN vbap ON vbap.vbeln = vbak.vbeln
               AND vbap.posnr = prcd.kposn
WHERE prcd.kinak = ''
  AND prcd.kbetr <> '0'
ORDER BY vbap.vbeln, vbap.posnr, prcd.kschl;

-- 8. 参考销售订单信息
SELECT vbap.vbeln,
       vbap.posnr,
       tvak.kalvg,
       CASE WHEN vbkd.prsdt IS NOT INITIAL
            THEN vbkd.prsdt
            ELSE vbkd_h.prsdt
       END AS prsdt,
       vbkd.bstkd AS bstkd_el,
       vbkd_h.bstkd_e,
       vbkd_h.zterm
FROM vbak
INNER JOIN vbap ON vbap.vbeln = vbak.vbeln
INNER JOIN tvak ON tvak.auart = vbak.auart
LEFT JOIN vbkd ON vbkd.vbeln = vbap.vbeln
              AND vbkd.posnr = vbap.posnr
LEFT JOIN vbkd AS vbkd_h ON vbkd_h.vbeln = vbap.vbeln
                        AND vbkd_h.posnr = '000000'
ORDER BY vbap.vbeln, vbap.posnr;

-- 9. 凭证流/下单日期
SELECT vbfa.vbeln,
       vbfa.posnn,
       vbfa.vbelv,
       vbfa.posnv,
       vbak.erdat
FROM vbfa
INNER JOIN vbak ON vbak.vbeln = vbfa.vbelv
WHERE vbfa.stufe = (
    SELECT MAX(stufe) FROM vbfa AS vbfa_n
    WHERE vbfa_n.vbeln = vbfa.vbeln
      AND vbfa_n.posnn = vbfa.posnn
)
ORDER BY vbfa.vbeln, vbfa.posnn;

-- 10. 客户税号
SELECT dfkkbptaxnum.partner,
       dfkkbptaxnum.taxnumxl
FROM dfkkbptaxnum
ORDER BY dfkkbptaxnum.partner;

-- 11. 长文本 - 抬头
SELECT stxl.tdobject,
       stxl.tdid,
       stxl.tdname,
       stxl.clustr,
       stxl.clustd
FROM stxl
WHERE stxl.tdobject = 'VBBK'
  AND stxl.tdid = '0001'
  AND stxl.tdspras = @sy_langu
ORDER BY stxl.tdname;

-- 12. 长文本 - 行项目
SELECT stxl.tdobject,
       stxl.tdid,
       stxl.tdname,
       stxl.clustr,
       stxl.clustd
FROM stxl
WHERE stxl.tdobject = 'VBBP'
  AND stxl.tdid = '0001'
  AND stxl.tdspras = @sy_langu
ORDER BY stxl.tdname;
