/*
    Copyright 2018 0KIMS association.

    This file is part of snarkJS.

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

import * as binFileUtils from "@iden3/binfileutils";
import * as polyUtils from "./uni_poly_utils.js"
import * as zkeyUtils from "./uni_zkey_utils.js";
import * as wtnsUtils from "./wtns_utils.js";
import generateWitness from "./generate_witness.js"
import * as fastFile from "fastfile";
import { getCurveFromQ as getCurve } from "./curves.js";
import { log2 } from "./misc.js";
import { Scalar, utils, BigBuffer } from "ffjavascript";
const {stringifyBigInts} = utils;
import * as misc from './misc.js'
import * as timer from "./timer.js"

export default async function groth16Prove(cRSName, proofName, circuitName, instanceId, entropy) {
    const startTime = timer.start();
    let EncTimeStart;
    let EncTimeAccum = 0;
    let qapLoadTimeStart;
    let qapLoadTimeAccum = 0;

    const dirPath = `resource/circuits/${circuitName}`
    const TESTFLAG = false;
    const CRS = 1;

    console.log(`TESTMODE = ${TESTFLAG}`)

    const {fd: fdRS, sections: sectionsRS} = await binFileUtils.readBinFile(`${dirPath}/${cRSName}.crs`, "zkey", 2, 1<<25, 1<<23);
    const fdIdV = await fastFile.readExisting(`${dirPath}/Set_I_V.bin`, 1<<25, 1<<23);
    const fdIdP = await fastFile.readExisting(`${dirPath}/Set_I_P.bin`, 1<<25, 1<<23);
    const fdOpL = await fastFile.readExisting(`${dirPath}/OpList.bin`, 1<<25, 1<<23);
    const fdWrL = await fastFile.readExisting(`${dirPath}/WireList.bin`, 1<<25, 1<<23);
    
    const urs = {}
    const crs = {}
    urs.param = await zkeyUtils.readRSParams(fdRS, sectionsRS);
    const rs = await zkeyUtils.readRS(fdRS, sectionsRS, urs.param, CRS);
    const IdSetV = await zkeyUtils.readIndSet(fdIdV);
    const IdSetP = await zkeyUtils.readIndSet(fdIdP);
    const OpList = await zkeyUtils.readOpList(fdOpL);
    const WireList = await zkeyUtils.readWireList(fdWrL);
    await fdRS.close();
    await fdIdV.close();
    await fdIdP.close();
    await fdOpL.close();
    await fdWrL.close();

    const fdPrf = await binFileUtils.createBinFile(`${dirPath}/${proofName}.proof`, "prof", 1, 2, 1<<22, 1<<24);

    urs.sigma_G = rs.sigma_G;
    urs.sigma_H = rs.sigma_H;
    crs.param = rs.crs.param;
    crs.vk1_uxy_i = rs.crs.vk1_uxy_i;
    crs.vk1_vxy_i = rs.crs.vk1_vxy_i;
    crs.vk1_zxy_i = rs.crs.vk1_zxy_i;
    crs.vk1_axy_i = rs.crs.vk1_axy_i;
    crs.vk2_vxy_i = rs.crs.vk2_vxy_i;

    const ParamR1cs = urs.param.r1cs
    const curve = urs.param.curve
    const G1 = urs.param.curve.G1
    const G2 = urs.param.curve.G2
    const Fr = urs.param.curve.Fr
    const n8 = curve.Fr.n8;
    const buffG1 = curve.G1.oneAffine;
    const buffG2 = curve.G2.oneAffine;
    const n = urs.param.n;
    const n8r = urs.param.n8r;
    const s_max = urs.param.s_max;
    const s_D = urs.param.s_D;
    const s_F = OpList.length;
    const omega_x = await Fr.e(urs.param.omega_x);
    const omega_y = await Fr.e(urs.param.omega_y);
    
    const mPublic = crs.param.mPublic;
    const mPrivate = crs.param.mPrivate;
    const m = mPublic + mPrivate;

    if(!((mPublic == IdSetV.set.length) && (mPrivate == IdSetP.set.length)))
    {
        throw new Error(`Error in crs file: invalid crs parameters. mPublic: ${mPublic}, IdSetV: ${IdSetV.set.length}, mPrivate: ${mPrivate}, IdSetP: ${IdSetP.set.length},`)
    }

    
    // generate witness for each subcircuit
    console.log(`Solving QAP...`)
    let qapSolveTime = timer.start();
    console.log(`  Generating circuit witness...`)
    await generateWitness(circuitName, instanceId);
    const wtns = [];
    for(var k=0; k<OpList.length; k++ ){
        const wtns_k = await wtnsUtils.read(`${dirPath}/witness${instanceId}/witness${k}.wtns`);
        const kPrime = OpList[k];
        const m_k = ParamR1cs[kPrime].m;
        if (wtns_k.length != m_k) {
            throw new Error(`Invalid witness length. Circuit: ${m_k}, witness: ${wtns.length}`);
        }
        wtns.push(wtns_k);
    }

    /// TEST CODE 2
    if (TESTFLAG == true)
    {   
        console.log(`Running test 2`)
        const sR1cs = new Array();
        for(var k=0; k<s_D; k++){
            const {fd: fdR1cs, sections: sectionsR1cs} = await binFileUtils.readBinFile(`resource/subcircuits/r1cs/subcircuit${k}.r1cs`, "r1cs", 1, 1<<22, 1<<24);
            sR1cs.push(await binFileUtils.readSection(fdR1cs, sectionsR1cs, 2));
            await fdR1cs.close();
        }
        for(var k=0; k<OpList.length; k++){
            const kPrime = OpList[k];
            let processResults_k
            processResults_k = await zkeyUtils.processConstraints(curve, ParamR1cs[kPrime].nConstraints, sR1cs[kPrime]); // to fill U, V, W
            let U = processResults_k.U
            let Uid = processResults_k.Uid
            let V = processResults_k.V
            let Vid = processResults_k.Vid
            let W = processResults_k.W
            let Wid = processResults_k.Wid
            const wtns_k = wtns[k];

            let U_ids
            let U_coefs
            let V_ids
            let V_coefs
            let W_ids
            let W_coefs

            for(var i=0; i<ParamR1cs[kPrime].nConstraints; i++){
                U_ids=Uid[i];
                U_coefs=U[i];
                V_ids=Vid[i];
                V_coefs=V[i];
                W_ids=Wid[i];
                W_coefs=W[i];

                let constraintU = Fr.e(0);
                for(var j=0; j<U_ids.length; j++){
                    let term = Fr.mul(U_coefs[j], Fr.e(wtns_k[U_ids[j]]));
                    constraintU = Fr.add(constraintU, term);
                }
                let constraintV = Fr.e(0);
                for(var j=0; j<V_ids.length; j++){
                    let term = Fr.mul(V_coefs[j], Fr.e(wtns_k[V_ids[j]]));
                    constraintV = Fr.add(constraintV, term);
                }
                let constraintW = Fr.mul(constraintU, constraintV);
                for(var j=0; j<W_ids.length; j++){
                    let term = Fr.mul(W_coefs[j], Fr.e(wtns_k[W_ids[j]]));
                    constraintW = Fr.sub(constraintW, term);
                }
                if(!Fr.eq(constraintW, Fr.e(0))){
                    console.log(`U_ids: ${U_ids}`)
                    console.log(`U_coefs: ${U_coefs}`)
                    console.log(`V_ids: ${V_ids}`)
                    console.log(`V_coefs: ${V_coefs}`)
                    console.log(`W_ids: ${W_ids}`)
                    console.log(`W_coefs: ${W_coefs}`)
                    console.log(`wtns_k: ${wtns_k}`)
                    throw new Error(`assertion not passed at k: ${k}, i: ${i}, constraint: ${Fr.toObject(constraintW)}`)
                }
            }
        }
        console.log(`Test 2 finished`)
    }
    /// END of TEST CODE 2

    /// arrange circuit witness
    let cWtns = new Array(WireList.length);
    for(var i=0; i<WireList.length; i++){
        const kPrime = WireList[i][0];
        const idx = WireList[i][1];
        cWtns[i] = Fr.e(wtns[kPrime][idx]);
        if (cWtns[i] === undefined){
            throw new Error(`Undefined cWtns value at i=${i}`)
        }
    }
  
    let tX = Array.from(Array(n+1), () => new Array(1));
    let tY = Array.from(Array(1), () => new Array(s_max+1));
    tX = await polyUtils.scalePoly(Fr, tX, Fr.zero);
    tY = await polyUtils.scalePoly(Fr, tY, Fr.zero);
    tX[0][0] = Fr.negone;
    tX[n][0] = Fr.one;
    tY[0][0] = Fr.negone;
    tY[0][s_max] = Fr.one;
    // t(X,Y) = (X^n-1) * (X^s_max-1) = PI(X-omega_x^i) for i=0,...,n * PI(Y-omega_y^j) for j =0,...,s_max
    // P(X,Y) = (SUM c_i*u_i(X,Y))*(SUM c_i*v_i(X,Y)) - (SUM c_i*w_i(X,Y)) = 0 at X=omega_x^i, Y=omega_y^j
    // <=> P(X,Y) has zeros at least the points omega_x^i and omega_y^j
    // <=> there exists h(X,Y) such that p(X,Y) = t(X,Y) * h(X,Y)
    // <=> finding h(X,Y) is the goal of Prove algorithm
    
    /// compute p(X,Y)
    console.log(`  Computing p(X,Y)...`)
    const {fd: fdQAP, sections: sectionsQAP}  = await binFileUtils.readBinFile(`resource/circuits/${circuitName}/circuitQAP.qap`, "qapp", 1, 1<<22, 1<<24);
    let pxyTime = timer.start();
    let InitPoly = Array.from(Array(n), () => new Array(s_max));
    InitPoly = await polyUtils.scalePoly(Fr, InitPoly, Fr.zero);
    let p1XY = InitPoly;
    let p2XY = InitPoly;
    let p3XY = InitPoly;
    for(var i=0; i<m; i++){
        qapLoadTimeStart = timer.start();
        const {uXY_i, vXY_i, wXY_i} = await polyUtils.readCircuitQAP_i(Fr, fdQAP, sectionsQAP, i, n, s_max, n8r);
        qapLoadTimeAccum += timer.end(qapLoadTimeStart);
        let term1 = await polyUtils.scalePoly(Fr, uXY_i, cWtns[i]);
        p1XY = await polyUtils.addPoly(Fr, p1XY, term1);
        let term2 = await polyUtils.scalePoly(Fr, vXY_i, cWtns[i]);
        p2XY = await polyUtils.addPoly(Fr, p2XY, term2);
        let term3 = await polyUtils.scalePoly(Fr, wXY_i, cWtns[i]);
        p3XY = await polyUtils.addPoly(Fr, p3XY, term3);
    }
    await fdQAP.close();

    const temp = await polyUtils.mulPoly(Fr, p1XY, p2XY);
    const pXY = await polyUtils.addPoly(Fr, temp, p3XY, true);
    pxyTime = timer.end(pxyTime);
    
    /// compute H
    console.log(`  Finding h1(X,Y)...`)
    let PolDivTime = timer.start();
    const {res: h1XY, finalrem: rem1} =  await polyUtils.divPolyByX(Fr, pXY, tX);
    console.log(`  Finding h2(X,Y)...`)
    const {res: h2XY, finalrem: rem2} =  await polyUtils.divPolyByY(Fr, rem1, tY);
    PolDivTime = timer.end(PolDivTime);
    qapSolveTime = timer.end(qapSolveTime);
    console.log(`Solving QAP...Done`)
    if (TESTFLAG){
        console.log(`rem: ${rem2}`);
    }

    if(TESTFLAG){
        //console.log(`rem2: ${polyUtils._transToObject(Fr, rem2)}`)
        const {x_order: h1_x_order, y_order: h1_y_order} = polyUtils._orderPoly(Fr, h1XY);
        const {x_order: h2_x_order, y_order: h2_y_order} = polyUtils._orderPoly(Fr, h2XY);
        console.log(`h1_x_order: ${h1_x_order}, h1_y_order: ${h1_y_order}`);
        console.log(`h2_x_order: ${h2_x_order}, h2_y_order: ${h2_y_order}`);
        console.log(`n: ${n}, s_max: ${s_max}`);
    }

        /// TEST CODE 3
        if (TESTFLAG){
            console.log('Running Test 3')
            for (var i=0; i<n; i++){
                for (var j=0; j<s_max; j++){
                    const eval_point_X = await Fr.exp(omega_x, i);
                    const eval_point_Y = await Fr.exp(omega_y, j);
                    const flag = await polyUtils.evalPoly(Fr, pXY, eval_point_X, eval_point_Y);
                    if( !Fr.eq(flag, Fr.zero) ){
                        throw new Error('Error in pXY');
                    }
                }
            }
            let res = pXY;
            let temp1 = await polyUtils_mulPoly(Fr, h1XY, tX);
            let temp2 = await polyUtils_mulPoly(Fr, h2XY, tY);
            res= await polyUtils.addPoly(Fr, res, temp1, true);
            res= await polyUtils.addPoly(Fr, res, temp2, true);
            if (!Fr.eq(await polyUtils.evalPoly(Fr, res, Fr.one, Fr.one), Fr.zero)){
                throw new Error('Error in pXY=h1t+h2t');
            }
            
            console.log(`Test 3 finished`)
        }       
        /// End of TEST CODE 3   

    // Generate r and s
    const rawr = await misc.getRandomRng(entropy);
    const raws = await misc.getRandomRng(entropy+1);
    const r = Fr.fromRng(rawr);
    const s = Fr.fromRng(raws);
    
    console.log(`Generating Proofs...`)
    let provingTime = timer.start();
    console.log(`  Generating Proof A...`)
    // Compute proof A
    const vk1_A_p1 = urs.sigma_G.vk1_alpha_v;
    const vk1_A_p3 = await G1_timesFr(urs.sigma_G.vk1_gamma_a, r);
    let vk1_A_p2 = await G1_timesFr(buffG1, Fr.e(0));
    for(var i=0; i<m; i++){
        let term = await G1_timesFr(crs.vk1_uxy_i[i], cWtns[i]);
        vk1_A_p2 = await G1.add(vk1_A_p2, term);
    }
    const vk1_A = await G1.add(await G1.add(vk1_A_p1, vk1_A_p2), vk1_A_p3);
    
    console.log(`  Generating Proof B...`)
    // Compute proof B_H
    const vk2_B_p1 = urs.sigma_H.vk2_alpha_u;
    const vk2_B_p3 = await G2_timesFr(urs.sigma_H.vk2_gamma_a, s);
    let vk2_B_p2 = await G2_timesFr(buffG2, Fr.e(0));
    for(var i=0; i<m; i++){
        let term = await G2_timesFr(crs.vk2_vxy_i[i], cWtns[i]);
        vk2_B_p2 = await G2.add(vk2_B_p2, term);
    }
    const vk2_B = await G2.add(await G2.add(vk2_B_p1, vk2_B_p2), vk2_B_p3);

    console.log(`  Generating Proof C...`)
    // Compute proof B_G
    const vk1_B_p1 = urs.sigma_G.vk1_alpha_u;
    const vk1_B_p3 = await G1_timesFr(urs.sigma_G.vk1_gamma_a, s);
    let vk1_B_p2 = await G1_timesFr(buffG1, Fr.e(0));
    for(var i=0; i<m; i++){
        let term = await G1_timesFr(crs.vk1_vxy_i[i], cWtns[i]);
        vk1_B_p2 = await G1.add(vk1_B_p2, term);
    }
    const vk1_B = await G1.add(await G1.add(vk1_B_p1, vk1_B_p2), vk1_B_p3);

    // Compute proof C_G
    let vk1_C_p = new Array(6)
    vk1_C_p[0] = await G1_timesFr(buffG1, Fr.e(0));
    for(var i=0; i<mPrivate; i++){
        let term = await G1_timesFr(crs.vk1_axy_i[i], cWtns[IdSetP.set[i]]);
        vk1_C_p[0] = await G1.add(vk1_C_p[0], term);
    }
    vk1_C_p[1] = await G1_timesFr(buffG1, Fr.e(0));
    for(var i=0; i<n-1; i++){
        for(var j=0; j<2*s_max-1; j++){
            let term = await G1_timesFr(urs.sigma_G.vk1_xy_pows_t1g[i][j], h1XY[i][j]);
            vk1_C_p[1] = await G1.add(vk1_C_p[1], term);
        }
    }
    vk1_C_p[2] = await G1_timesFr(buffG1, Fr.e(0));
    for(var i=0; i<n; i++){
        for(var j=0; j<s_max-1; j++){
            let term = await G1_timesFr(urs.sigma_G.vk1_xy_pows_t2g[i][j], h2XY[i][j]);
            vk1_C_p[2] = await G1.add(vk1_C_p[2], term);
        }
    }
    vk1_C_p[3] = await G1_timesFr(vk1_A, s);
    vk1_C_p[4] = await G1_timesFr(vk1_B, r);
    vk1_C_p[5] = await G1_timesFr(urs.sigma_G.vk1_gamma_a, Fr.neg(Fr.mul(r,s)));
    let vk1_C = vk1_C_p[0];
    for(var i=1; i<6; i++){
        vk1_C = await G1.add(vk1_C, vk1_C_p[i]);
    }
    provingTime = timer.end(provingTime);
    console.log(`Generating Proofs...Done`)

    /// TEST CODE 4
    if (TESTFLAG){
        console.log('Running Test 4')
        const x = Fr.e(13);
        const y = Fr.e(23);
        let res = [];

        res.push(await curve.pairingEq(urs.sigma_G.vk1_xy_pows[1][0], urs.sigma_H.vk2_xy_pows[0][1],
            await G1_timesFr(buffG1, Fr.mul(x,y)), await G2.neg(buffG2))
        );

        const p1xy = await polyUtils.evalPoly(Fr, p1XY, x, y);
        const p2xy = await polyUtils.evalPoly(Fr, p2XY, x, y);
        const p3xy = await polyUtils.evalPoly(Fr, p3XY, x, y);
        const test_vk1_U = await G1_timesFr(buffG1, p1xy);
        const test_vk1_V = await G1_timesFr(buffG1, p2xy);
        const test_vk2_V = await G2_timesFr(buffG2, p2xy);
        const test_vk1_W = await G1_timesFr(buffG1, p3xy);

        res.push(await curve.pairingEq(await G1.neg(test_vk1_U), test_vk2_V,
            vk1_A_p2, vk2_B_p2
            )
        );

        let vk1_D
        vk1_D = await G1_timesFr(buffG1, Fr.e(0));
        for(var i=0; i<mPublic; i++){
            let term = await G1_timesFr(crs.vk1_zxy_i[i], cWtns[IdSetV.set[i]]);
            vk1_D = await G1.add(vk1_D, term);
        }

        res.push(await curve.pairingEq(test_vk1_U, urs.sigma_H.vk2_alpha_u,
            urs.sigma_G.vk1_alpha_v, test_vk2_V,
            test_vk1_W, buffG2,
            vk1_C_p[0], await G2.neg(urs.sigma_H.vk2_gamma_a),
            vk1_D, await G2.neg(urs.sigma_H.vk2_gamma_z),
            )
        );


        const tx= await polyUtils.evalPoly(Fr, tX, x, Fr.one);
        const ty= await polyUtils.evalPoly(Fr, tY, Fr.one, y);
        const h1xy = await polyUtils.evalPoly(Fr, h1XY, x, y);
        const h2xy = await polyUtils.evalPoly(Fr, h2XY, x, y);
        const h1txh2ty = await Fr.add(Fr.mul(tx,h1xy), Fr.mul(ty,h2xy));
        const test_vk1_h1txh2ty = await G1_timesFr(buffG1, h1txh2ty);

        res.push(await curve.pairingEq(urs.sigma_G.vk1_xy_pows_t1g[1][1], urs.sigma_H.vk2_gamma_a,
            await G1_timesFr(buffG1, Fr.mul(x,y)), await G2.neg(await G2_timesFr(buffG2, tx))
            )
        );

        res.push(await curve.pairingEq(vk1_A_p2, vk2_B_p2,
            await G1.neg(test_vk1_W), buffG2,
            test_vk1_h1txh2ty, await G2.neg(buffG2)
            )
        );
 
        res.push(await curve.pairingEq(vk1_A_p2, vk2_B_p2,
            await G1.neg(test_vk1_W), buffG2,
            G1.add(vk1_C_p[1], vk1_C_p[2]), await G2.neg(urs.sigma_H.vk2_gamma_a)
            )
        );
        
        for (var i=0; i<res.length; i++){
            if (!res[i]){
                throw new Error(`Error in TEST CODE 4 at i=${i}`)
            }
        }
        console.log(`Test 4 finished`)
    }
    /// End of TEST CODE 4

    /// TEST CODE 5
    if (TESTFLAG){
        console.log('Running Test 5')
        let vk1_D
        vk1_D = await G1_timesFr(buffG1, Fr.e(0));
        for(var i=0; i<mPublic; i++){
            let term = await G1_timesFr(crs.vk1_zxy_i[i], cWtns[IdSetV.set[i]]);
            vk1_D = await G1.add(vk1_D, term);
        }

        /// Verify
        const res = await curve.pairingEq(urs.sigma_G.vk1_alpha_v, urs.sigma_H.vk2_alpha_u,
            vk1_D, urs.sigma_H.vk2_gamma_z,
            vk1_C, urs.sigma_H.vk2_gamma_a,
            await G1.neg(vk1_A),  vk2_B);
        if (!res){
            throw new Error(`Error in TEST CODE 5`)
        }
        console.log(`Test 5 finished`)
    }
    /// END of TEST CODE 5

    // Write Header
    ///////////
    await binFileUtils.startWriteSection(fdPrf, 1);
    await fdPrf.writeULE32(1); // Groth
    await binFileUtils.endWriteSection(fdPrf);
    // End of the Header

    await binFileUtils.startWriteSection(fdPrf, 2);
    await zkeyUtils.writeG1(fdPrf, curve, vk1_A);
    await zkeyUtils.writeG2(fdPrf, curve, vk2_B);
    await zkeyUtils.writeG1(fdPrf, curve, vk1_C);

    await binFileUtils.endWriteSection(fdPrf);

    await fdPrf.close();

    const totalTime = timer.end(startTime);
    console.log(` `)
    console.log(`-----Prove Time Analyzer-----`)
    console.log(`###Total ellapsed time: ${totalTime} [ms]`)
    console.log(` ##Time for solving QAP of degree (${n},${s_max}) with ${m} wires: ${qapSolveTime} [ms] (${qapSolveTime/totalTime*100} %)`)
    console.log(`  #Loading QAP time: ${qapLoadTimeAccum} [ms] (${qapLoadTimeAccum/totalTime*100} %)`)
    console.log(`  #Computing p(X,Y) time (including single multiplication): ${pxyTime-qapLoadTimeAccum} [ms] (${(pxyTime-qapLoadTimeAccum)/totalTime*100} %)`)
    console.log(`  #Finding h1(X,Y) and h2(X,Y) time (two divisions): ${PolDivTime} [ms] (${PolDivTime/totalTime*100} %)`)
    console.log(` ##Time for generating proofs with m=${m}, n=${n}, s_max=${s_max}: ${provingTime} [ms] (${provingTime/totalTime*100} %)`)
    console.log(`  #Encryption time: ${EncTimeAccum} [ms] (${EncTimeAccum/totalTime*100} %)`)
    
    async function G1_timesFr(point, fieldval){
        EncTimeStart = timer.start();
        const out = await G1.timesFr(point, fieldval);
        EncTimeAccum += timer.end(EncTimeStart);
        return out;
    }
    async function G2_timesFr(point, fieldval){
        EncTimeStart = timer.start();
        const out = await G2.timesFr(point, fieldval);
        EncTimeAccum += timer.end(EncTimeStart);
        return out;
    }
}