/* =========================================================================================
   MULTI-PANEL HOST / CHILD MODE
   ========================================================================================= */
const __MP_PARAMS = new URLSearchParams(window.location.search);
const __MP_CHILD = __MP_PARAMS.get("mpchild") === "1";

if (!__MP_CHILD) {
    document.body.classList.add("mp-shell");

    (function initMultiPanelHost() {
        const mapWrapper = document.getElementById("map-wrapper");
        const layoutSelect = document.getElementById("layout-select");
        const sidebar = document.getElementById("sidebar");
        const toolbar = document.getElementById("drawing-toolbar");
        const timeline = document.getElementById("timeline-bar");
        const savePng = document.getElementById("save-png");
        const saveGif = document.getElementById("save-gif");
        const panelGrid = document.createElement("div");
        panelGrid.id = "panel-grid";
        panelGrid.className = "layout-1";
        mapWrapper.replaceChildren(panelGrid);

        const panels = [];
        let activePanel = 0;
        let layoutCount = 1;
        let cameraBroadcasting = false;
        let lastTimelineValue = null;
        let sharedAnnotations = [];
        let sharedCurrentAnnotation = null;
        let sharedPointerId = null;
        let sharedSourcePanel = -1;
        let sharedDrawingTool = "pan";
        const parameterScope = document.getElementById("parameter-scope");
        const drawingScope = document.getElementById("drawing-scope");
        const sharedCanvas = document.createElement("canvas");
        sharedCanvas.id = "mp-shared-annotation-canvas";
        panelGrid.appendChild(sharedCanvas);
        const sharedCtx = sharedCanvas.getContext("2d");

        function parameterTargets() {
            return parameterScope && parameterScope.value === "all"
                ? Array.from({ length: layoutCount }, (_, i) => i)
                : [activePanel];
        }
        function drawingTargets() {
            return drawingScope && drawingScope.value === "all"
                ? Array.from({ length: layoutCount }, (_, i) => i)
                : [activePanel];
        }

        function cloneAnnotations(data) {
            return (Array.isArray(data) ? data : []).map(a => ({
                ...a,
                points: Array.isArray(a.points)
                    ? a.points.map(p => ({ lng: Number(p.lng), lat: Number(p.lat) }))
                    : []
            }));
        }

        const SHARED_ANNOTATION_STYLE = {
            cold:       { line: "#0047ff", width: 3.2, spacing: 38, size: 10 },
            warm:       { line: "#ed1010", width: 3.2, spacing: 38, size: 10 },
            stationary: { line: "#111111", width: 3.0, spacing: 40, size: 10 },
            occluded:   { line: "#8d009f", width: 3.2, spacing: 38, size: 10 },
            dryline:    { line: "#f28a00", width: 3.0, spacing: 34, size: 9 },
            trough:     { line: "#8b4a12", width: 3.0 }
        };

        function resizeSharedCanvas() {
            const r = panelGrid.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const w = Math.max(1, Math.round((r.width - 8) * dpr));
            const h = Math.max(1, Math.round((r.height - 8) * dpr));
            if (sharedCanvas.width !== w || sharedCanvas.height !== h) {
                sharedCanvas.width = w; sharedCanvas.height = h;
            }
            sharedCanvas.style.width = `${Math.max(1, r.width - 8)}px`;
            sharedCanvas.style.height = `${Math.max(1, r.height - 8)}px`;
            sharedCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            sharedCtx.lineCap = "round";
            sharedCtx.lineJoin = "round";
        }

        function panelGeometry(index) {
            if (!panels[index] || index >= layoutCount) return null;
            const gridRect = panelGrid.getBoundingClientRect();
            const holderRect = panels[index].holder.getBoundingClientRect();
            let mapSize = null;
            try {
                const cw = panels[index].frame.contentWindow;
                mapSize = cw && typeof cw.__mpMapSize === "function" ? cw.__mpMapSize() : null;
            } catch (_) {}
            return {
                x: holderRect.left - gridRect.left - 4,
                y: holderRect.top - gridRect.top - 4,
                width: holderRect.width,
                height: mapSize?.height || holderRect.height,
                holderHeight: holderRect.height
            };
        }

        function panelAtCanvasPoint(x, y) {
            for (let i = 0; i < layoutCount; i++) {
                const g = panelGeometry(i);
                if (!g) continue;
                if (x >= g.x && x <= g.x + g.width && y >= g.y && y <= g.y + g.height) return i;
            }
            return -1;
        }

        function unprojectShared(index, x, y) {
            const g = panelGeometry(index);
            if (!g) return null;
            try {
                const cw = panels[index].frame.contentWindow;
                return cw.__mpUnproject(x - g.x, y - g.y);
            } catch (_) { return null; }
        }

        function projectShared(index, ll) {
            const g = panelGeometry(index);
            if (!g) return null;
            try {
                const cw = panels[index].frame.contentWindow;
                const p = cw.__mpProject(ll);
                return p ? { x: g.x + p.x, y: g.y + p.y } : null;
            } catch (_) { return null; }
        }

        function sharedSmoothPath(ctx, pts) {
            if (!pts.length) return;
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
            if (pts.length === 2) { ctx.lineTo(pts[1].x, pts[1].y); return; }
            for (let i = 1; i < pts.length - 1; i++) {
                const mx = (pts[i].x + pts[i+1].x)/2, my = (pts[i].y + pts[i+1].y)/2;
                ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
            }
            if (pts.length > 1) ctx.lineTo(pts[pts.length-1].x, pts[pts.length-1].y);
        }

        function sharedResample(pts, spacing) {
            const out=[]; if (pts.length<2) return out;
            let carry=spacing*.65;
            for(let i=1;i<pts.length;i++){
                let ax=pts[i-1].x, ay=pts[i-1].y, bx=pts[i].x, by=pts[i].y;
                let dx=bx-ax, dy=by-ay, seg=Math.hypot(dx,dy); if(seg<.01) continue;
                let ux=dx/seg, uy=dy/seg;
                while(carry<=seg){
                    const x=ax+ux*carry, y=ay+uy*carry;
                    out.push({x,y,angle:Math.atan2(uy,ux)});
                    ax=x; ay=y; seg-=carry; carry=spacing;
                }
                carry-=seg;
            }
            return out;
        }

        function sharedTriangle(ctx,x,y,angle,side,size,color){
            const nx=-Math.sin(angle)*side, ny=Math.cos(angle)*side, tx=Math.cos(angle), ty=Math.sin(angle);
            const bx=x+nx*1.5, by=y+ny*1.5;
            ctx.beginPath(); ctx.moveTo(bx-tx*size*.72,by-ty*size*.72);
            ctx.lineTo(bx+tx*size*.72,by+ty*size*.72); ctx.lineTo(x+nx*size*1.35,y+ny*size*1.35);
            ctx.closePath(); ctx.fillStyle=color; ctx.fill(); ctx.strokeStyle=color; ctx.lineWidth=1; ctx.stroke();
        }

        function sharedSemicircle(ctx,x,y,angle,side,size,color){
            ctx.save(); ctx.translate(x,y); ctx.rotate(angle); ctx.beginPath(); ctx.moveTo(-size,0);
            for(let i=0;i<=18;i++){const t=Math.PI-(Math.PI*i/18);ctx.lineTo(size*Math.cos(t),side*size*Math.sin(t));}
            ctx.closePath(); ctx.fillStyle=color; ctx.fill(); ctx.strokeStyle=color; ctx.lineWidth=2.2; ctx.stroke(); ctx.restore();
        }

        function renderSharedAnnotationForPanel(annotation, index) {
            if (!annotation?.points?.length) return;
            const g = panelGeometry(index); if (!g) return;
            const pts = annotation.points.map(ll => projectShared(index,ll)).filter(Boolean);
            if (!pts.length) return;
            sharedCtx.save();
            sharedCtx.beginPath(); sharedCtx.rect(g.x,g.y,g.width,g.height); sharedCtx.clip();

            if (annotation.type === "high" || annotation.type === "low") {
                const p=pts[0], letter=annotation.type==="high"?"H":"L";
                sharedCtx.font='800 58px Inter, "Segoe UI", Arial, sans-serif';
                sharedCtx.textAlign="center"; sharedCtx.textBaseline="middle"; sharedCtx.lineWidth=3;
                sharedCtx.strokeStyle="rgba(255,255,255,.9)";
                sharedCtx.fillStyle=annotation.type==="high"?"#003cff":"#ed0000";
                sharedCtx.strokeText(letter,p.x,p.y); sharedCtx.fillText(letter,p.x,p.y); sharedCtx.restore(); return;
            }
            if (annotation.type === "pen") {
                sharedCtx.strokeStyle=annotation.color||"#ff3030"; sharedCtx.lineWidth=annotation.width||4;
                sharedSmoothPath(sharedCtx,pts); sharedCtx.stroke(); sharedCtx.restore(); return;
            }
            const style=SHARED_ANNOTATION_STYLE[annotation.type];
            if (!style || pts.length<2){sharedCtx.restore();return;}
            sharedCtx.strokeStyle=style.line; sharedCtx.lineWidth=style.width;
            sharedCtx.setLineDash(annotation.type==="trough"?[11,8]:[]);
            sharedSmoothPath(sharedCtx,pts); sharedCtx.stroke(); sharedCtx.setLineDash([]);
            if(annotation.type!=="trough"){
                sharedResample(pts,style.spacing).forEach((m,k)=>{
                    if(annotation.type==="cold") sharedTriangle(sharedCtx,m.x,m.y,m.angle,-1,style.size,"#0047ff");
                    else if(annotation.type==="warm") sharedSemicircle(sharedCtx,m.x,m.y,m.angle,-1,style.size,"#ed1010");
                    else if(annotation.type==="stationary"){
                        if(k%2===0) sharedTriangle(sharedCtx,m.x,m.y,m.angle,-1,style.size,"#0047ff");
                        else sharedSemicircle(sharedCtx,m.x,m.y,m.angle,1,style.size,"#ed1010");
                    } else if(annotation.type==="occluded"){
                        if(k%2===0) sharedTriangle(sharedCtx,m.x,m.y,m.angle,-1,style.size,"#8d009f");
                        else sharedSemicircle(sharedCtx,m.x,m.y,m.angle,-1,style.size,"#8d009f");
                    } else if(annotation.type==="dryline") sharedSemicircle(sharedCtx,m.x,m.y,m.angle,-1,style.size,"#f28a00");
                });
            }
            sharedCtx.restore();
        }

        function renderSharedOverlay() {
            resizeSharedCanvas();
            const r=sharedCanvas.getBoundingClientRect();
            sharedCtx.clearRect(0,0,r.width,r.height);
            if (!drawingScope || drawingScope.value!=="all") return;
            for(let i=0;i<layoutCount;i++){
                sharedAnnotations.forEach(a=>renderSharedAnnotationForPanel(a,i));
                if(sharedCurrentAnnotation) renderSharedAnnotationForPanel(sharedCurrentAnnotation,i);
            }
        }

        function setSharedDrawingTool(tool) {
            sharedDrawingTool=tool||"pan";
            document.querySelectorAll("#drawing-toolbar .draw-tool[data-tool]").forEach(b=>b.classList.toggle("active",b.dataset.tool===sharedDrawingTool));
            sharedCanvas.classList.toggle("drawing-active",drawingScope.value==="all" && sharedDrawingTool!=="pan" && sharedDrawingTool!=="eraser");
            sharedCanvas.classList.toggle("erasing-active",drawingScope.value==="all" && sharedDrawingTool==="eraser");
            const hints={pan:"Pan mode",pen:"Drag to draw",cold:"Drag a cold front",warm:"Drag a warm front",stationary:"Drag a stationary front",occluded:"Drag an occluded front",dryline:"Drag a dryline",trough:"Drag a surface trough",high:"Click to place H",low:"Click to place L",eraser:"Click an annotation to erase"};
            const h=document.getElementById("draw-hint"); if(h) h.textContent=hints[sharedDrawingTool]||"";
        }

        function sharedPointSegmentDistance(px,py,ax,ay,bx,by){
            const dx=bx-ax,dy=by-ay,len2=dx*dx+dy*dy;if(!len2)return Math.hypot(px-ax,py-ay);
            let t=((px-ax)*dx+(py-ay)*dy)/len2;t=Math.max(0,Math.min(1,t));
            return Math.hypot(px-(ax+t*dx),py-(ay+t*dy));
        }

        function eraseSharedAt(panelIndex,x,y){
            let best=-1,bestD=Infinity;
            sharedAnnotations.forEach((a,idx)=>{
                const pts=(a.points||[]).map(ll=>projectShared(panelIndex,ll)).filter(Boolean);
                let d=Infinity;
                if(a.type==="high"||a.type==="low"){if(pts[0])d=Math.hypot(x-pts[0].x,y-pts[0].y);}
                else for(let j=1;j<pts.length;j++)d=Math.min(d,sharedPointSegmentDistance(x,y,pts[j-1].x,pts[j-1].y,pts[j].x,pts[j].y));
                if(d<bestD){bestD=d;best=idx;}
            });
            if(best>=0&&bestD<=18){sharedAnnotations.splice(best,1);renderSharedOverlay();}
        }

        function canvasXY(event){
            const r=sharedCanvas.getBoundingClientRect();
            return {x:event.clientX-r.left,y:event.clientY-r.top};
        }

        sharedCanvas.addEventListener("pointerdown",event=>{
            if(drawingScope.value!=="all"||sharedDrawingTool==="pan")return;
            event.preventDefault(); event.stopPropagation();
            const p=canvasXY(event),panel=panelAtCanvasPoint(p.x,p.y); if(panel<0)return;
            if(sharedDrawingTool==="eraser"){eraseSharedAt(panel,p.x,p.y);return;}
            const ll=unprojectShared(panel,p.x,p.y); if(!ll)return;
            if(sharedDrawingTool==="high"||sharedDrawingTool==="low"){
                sharedAnnotations.push({type:sharedDrawingTool,points:[ll]});renderSharedOverlay();return;
            }
            sharedPointerId=event.pointerId;sharedSourcePanel=panel;sharedCanvas.setPointerCapture(event.pointerId);
            sharedCurrentAnnotation={type:sharedDrawingTool,points:[ll],color:document.getElementById("draw-color")?.value||"#ff3030",width:Math.max(1,Math.min(12,Number(document.getElementById("draw-width")?.value)||4))};
            renderSharedOverlay();
        });

        sharedCanvas.addEventListener("pointermove",event=>{
            if(!sharedCurrentAnnotation||event.pointerId!==sharedPointerId)return;
            event.preventDefault();
            const p=canvasXY(event),ll=unprojectShared(sharedSourcePanel,p.x,p.y); if(!ll)return;
            const pts=sharedCurrentAnnotation.points,last=pts[pts.length-1];
            const a=projectShared(sharedSourcePanel,last),b=projectShared(sharedSourcePanel,ll);
            if(a&&b&&Math.hypot(b.x-a.x,b.y-a.y)>=3){pts.push(ll);renderSharedOverlay();}
        });

        function finishSharedDrawing(event){
            if(!sharedCurrentAnnotation||event.pointerId!==sharedPointerId)return;
            event.preventDefault();
            if(sharedCurrentAnnotation.points.length>=2)sharedAnnotations.push(sharedCurrentAnnotation);
            sharedCurrentAnnotation=null;sharedPointerId=null;sharedSourcePanel=-1;
            try{sharedCanvas.releasePointerCapture(event.pointerId);}catch(_){}
            renderSharedOverlay();
        }
        sharedCanvas.addEventListener("pointerup",finishSharedDrawing);
        sharedCanvas.addEventListener("pointercancel",finishSharedDrawing);

        function childUrl(index) {
            const u = new URL(window.location.href);
            u.searchParams.set("mpchild", "1");
            u.searchParams.set("panel", String(index + 1));
            return u.toString();
        }

        for (let i = 0; i < 4; i++) {
            const holder = document.createElement("div");
            holder.className = "mp-panel" + (i === 0 ? " active" : "");
            holder.dataset.panel = String(i);
            const badge = document.createElement("div");
            badge.className = "mp-panel-badge";
            badge.textContent = `Panel ${i + 1}`;
            const frame = document.createElement("iframe");
            frame.title = `Mesoanalysis Panel ${i + 1}`;
            frame.loading = i === 0 ? "eager" : "lazy";
            // Only initialize the first panel until another layout is requested.
            if (i === 0) frame.src = childUrl(i);
            holder.append(badge, frame);
            panelGrid.appendChild(holder);
            panels.push({ holder, frame, badge, ready: false });
        }

        function visiblePanelCount() { return layoutCount; }

        function applyLayout(count) {
            layoutCount = Number(count) === 4 ? 4 : Number(count) === 2 ? 2 : 1;
            panelGrid.className = `layout-${layoutCount}`;
            panels.forEach((p, i) => {
                p.holder.style.display = i < layoutCount ? "block" : "none";
                if (i < layoutCount && !p.frame.hasAttribute("src")) {
                    p.frame.src = childUrl(i);
                }
            });
            if (activePanel >= layoutCount) setActivePanel(0);
            requestAnimationFrame(() => {
                panels.slice(0, layoutCount).forEach(p => {
                    try {
                        p.frame.contentWindow.postMessage({ type: "mp-layout", count: layoutCount }, "*");
                        p.frame.contentWindow.postMessage({ type: "mp-resize" }, "*");
                    } catch (_) {}
                });
                renderSharedOverlay();
            });
        }

        function setActivePanel(index) {
            if (index < 0 || index >= layoutCount) return;
            activePanel = index;
            panels.forEach((p, i) => p.holder.classList.toggle("active", i === activePanel));
            syncHostFromActiveChild();
        }

        function childDoc(index = activePanel) {
            try { return panels[index].frame.contentDocument; } catch (_) { return null; }
        }

        function childElById(id, index = activePanel) {
            const d = childDoc(index);
            return d ? d.getElementById(id) : null;
        }

        function dispatchChildValue(source, index, eventType = "change") {
            if (!source || !source.id) return;
            const target = childElById(source.id, index);
            if (!target) return;
            if (source.type === "checkbox" || source.type === "radio") target.checked = source.checked;
            else target.value = source.value;
            target.dispatchEvent(new Event(eventType, { bubbles: true }));
        }

        function clickChildById(id, index = activePanel) {
            const el = childElById(id, index);
            if (el) el.click();
        }

        function clickChildField(field, index = activePanel) {
            const d = childDoc(index);
            if (!d) return;
            const row = Array.from(d.querySelectorAll(".field-choice")).find(el => el.dataset.field === field);
            if (row) row.click();
        }

        function broadcastTimelineControl(source, eventType) {
            for (let i = 0; i < layoutCount; i++) dispatchChildValue(source, i, eventType);
        }

        function syncHostFromActiveChild() {
            const d = childDoc();
            if (!d) return;
            // CWA options are fetched within each child panel. Mirror the populated
            // office list into the visible host sidebar (otherwise only All CWAs exists).
            const hostCwa = document.getElementById("cwa-selector");
            const childCwa = d.getElementById("cwa-selector");
            if (hostCwa && childCwa && childCwa.options.length) {
                hostCwa.replaceChildren(...Array.from(childCwa.options, o => new Option(o.textContent, o.value)));
                hostCwa.value = childCwa.value || "ALL";
            }
            document.querySelectorAll("#sidebar input[id], #sidebar select[id], #drawing-toolbar input[id], #timeline-bar input[id], #timeline-bar select[id]").forEach(host => {
                if (host.id === "layout-select" || host.id === "parameter-scope" || host.id === "drawing-scope") return;
                const child = d.getElementById(host.id);
                if (!child) return;
                if (host.type === "checkbox" || host.type === "radio") host.checked = child.checked;
                else host.value = child.value;
            });
            document.querySelectorAll("#sidebar .field-choice").forEach(host => {
                const field = host.dataset.field;
                const child = Array.from(d.querySelectorAll(".field-choice")).find(el => el.dataset.field === field);
                host.classList.toggle("active", !!child && child.classList.contains("active"));
            });
            document.querySelectorAll("#drawing-toolbar .draw-tool[data-tool]").forEach(host => {
                const child = d.querySelector(`.draw-tool[data-tool="${host.dataset.tool}"]`);
                host.classList.toggle("active", !!child && child.classList.contains("active"));
            });
            // Mirror run information and loading status from the active map panel.
            // These labels live in the host sidebar and otherwise remain stuck
            // at the HTML defaults ("Loading..." / "Initializing...").
            ["run-id", "analysis-time", "status", "timeline-speed-label", "timeline-time-label", "draw-hint"].forEach(id => {
                const host = document.getElementById(id), child = d.getElementById(id);
                if (host && child) host.textContent = child.textContent;
            });
            const hs = document.getElementById("timeline-slider"), cs = d.getElementById("timeline-slider");
            if (hs && cs) { hs.min = cs.min; hs.max = cs.max; hs.value = cs.value; }
        }

        function syncTimeFromActiveChild() {
            const d = childDoc();
            if (!d) return;
            const slider = d.getElementById("timeline-slider");
            if (!slider) return;
            const key = `${slider.min}|${slider.max}|${slider.value}`;
            if (key === lastTimelineValue) return;
            lastTimelineValue = key;
            for (let i = 0; i < layoutCount; i++) {
                if (i === activePanel) continue;
                const other = childElById("timeline-slider", i);
                if (!other) continue;
                other.min = slider.min; other.max = slider.max; other.value = slider.value;
                other.dispatchEvent(new Event("input", { bubbles: true }));
                other.dispatchEvent(new Event("change", { bubbles: true }));
            }
        }

        layoutSelect.addEventListener("change", () => applyLayout(layoutSelect.value));

        sidebar.addEventListener("click", event => {
            const clearButton = event.target.closest("button#clear-fill, button#clear-contours");
            if (clearButton) {
                event.preventDefault();
                for (const i of parameterTargets()) clickChildById(clearButton.id, i);
                setTimeout(syncHostFromActiveChild, 80);
                return;
            }
            const row = event.target.closest(".field-choice");
            if (row) {
                for (const i of parameterTargets()) clickChildField(row.dataset.field, i);
                setTimeout(syncHostFromActiveChild, 50);
                return;
            }
            const input = event.target.closest("input[id]");
            if (input && input.type === "checkbox") {
                const targets = parameterTargets();
                setTimeout(() => {
                    for (const i of targets) {
                        const target = childElById(input.id, i);
                        if (target && target.checked !== input.checked) target.click();
                    }
                    syncHostFromActiveChild();
                }, 0);
            }
        }, true);

        sidebar.addEventListener("change", event => {
            const el = event.target;
            if (!el || !el.id || el.id === "layout-select" || el.id === "parameter-scope") return;
            if (el.id === "sector-select") {
                for (let i = 0; i < layoutCount; i++) dispatchChildValue(el, i, "change");
            } else if (el.tagName === "SELECT" || (el.tagName === "INPUT" && el.type !== "checkbox")) {
                for (const i of parameterTargets()) dispatchChildValue(el, i, "change");
            }
        });

        toolbar.addEventListener("click", event => {
            const button = event.target.closest("button");
            if (!button) return;
            if (button.id === "save-png") { event.preventDefault(); event.stopImmediatePropagation(); saveCombinedPng(); return; }
            if (button.id === "save-gif") { event.preventDefault(); event.stopImmediatePropagation(); clickChildById("save-gif"); return; }
            if (drawingScope.value === "all") {
                if (button.dataset.tool) {
                    setSharedDrawingTool(button.dataset.tool);
                } else if (button.id === "draw-undo") {
                    if (sharedAnnotations.length) sharedAnnotations.pop();
                    renderSharedOverlay();
                } else if (button.id === "draw-clear") {
                    sharedAnnotations = []; sharedCurrentAnnotation = null; renderSharedOverlay();
                }
                return;
            }
            if (button.id) clickChildById(button.id, activePanel);
            else if (button.dataset.tool) {
                const d = childDoc(activePanel);
                const target = d && d.querySelector(`.draw-tool[data-tool="${button.dataset.tool}"]`);
                if (target) target.click();
            }
            setTimeout(syncHostFromActiveChild, 30);
        }, true);

        drawingScope.addEventListener("change", () => {
            if (drawingScope.value === "all") {
                try {
                    const child = panels[activePanel]?.frame.contentWindow;
                    sharedAnnotations = child && typeof child.__mpGetAnnotations === "function"
                        ? cloneAnnotations(child.__mpGetAnnotations()) : [];
                } catch (_) { sharedAnnotations = []; }
                for (let i=0;i<layoutCount;i++) {
                    const d=childDoc(i), pan=d&&d.querySelector('.draw-tool[data-tool="pan"]');
                    if(pan) pan.click();
                }
                setSharedDrawingTool(sharedDrawingTool === "pan" ? "pan" : sharedDrawingTool);
                renderSharedOverlay();
            } else {
                sharedCanvas.classList.remove("drawing-active","erasing-active");
                renderSharedOverlay();
                syncHostFromActiveChild();
            }
        });

        toolbar.addEventListener("change", event => {
            const el = event.target;
            if (!el || !el.id || el.id === "drawing-scope") return;
            if (drawingScope.value === "all") return;
            dispatchChildValue(el, activePanel, "change");
        });
        toolbar.addEventListener("input", event => {
            const el = event.target;
            if (!el || !el.id || el.id === "drawing-scope") return;
            if (drawingScope.value === "all") return;
            dispatchChildValue(el, activePanel, "input");
        });

        timeline.addEventListener("click", event => {
            const button = event.target.closest("button[id]");
            if (!button) return;
            for (let i = 0; i < layoutCount; i++) clickChildById(button.id, i);
            setTimeout(syncHostFromActiveChild, 40);
        }, true);
        timeline.addEventListener("change", event => {
            const el = event.target;
            if (!el || !el.id) return;
            broadcastTimelineControl(el, "change");
        });
        timeline.addEventListener("input", event => {
            const el = event.target;
            if (!el || !el.id) return;
            broadcastTimelineControl(el, "input");
        });

        window.addEventListener("message", event => {
            const msg = event.data || {};
            if (!msg.type) return;
            if (msg.type === "mp-ready") {
                const i = Number(msg.panel) - 1;
                if (panels[i]) {
                    panels[i].ready = true;
                    try {
                        panels[i].frame.contentWindow.postMessage({ type: "mp-layout", count: layoutCount }, "*");
                    } catch (_) {}
                }
                if (i === activePanel) syncHostFromActiveChild();
            } else if (msg.type === "mp-activate") {
                setActivePanel(Number(msg.panel) - 1);
            } else if (msg.type === "mp-camera" && msg.camera && !cameraBroadcasting) {
                const source = Number(msg.panel) - 1;
                cameraBroadcasting = true;
                for (let i = 0; i < layoutCount; i++) {
                    if (i === source) continue;
                    panels[i].frame.contentWindow.postMessage({ type: "mp-set-camera", camera: msg.camera }, "*");
                }
                setTimeout(() => { cameraBroadcasting = false; renderSharedOverlay(); }, 100);
            }
        });

        async function saveCombinedPng() {
            const old = savePng.textContent;
            savePng.disabled = true;
            savePng.textContent = "Preparing…";
            try {
                const count = visiblePanelCount();
                const captures = [];
                const restoreAnnotations = [];
                for (let i = 0; i < count; i++) {
                    const w = panels[i].frame.contentWindow;
                    if (!w || typeof w.__mpCapturePanel !== "function") throw new Error(`Panel ${i + 1} is not ready.`);
                    if (drawingScope.value === "all" && typeof w.__mpGetAnnotations === "function" && typeof w.__mpSetAnnotations === "function") {
                        restoreAnnotations[i] = w.__mpGetAnnotations();
                        w.__mpSetAnnotations(sharedAnnotations);
                    }
                    captures.push(await w.__mpCapturePanel(1800));
                }
                if (drawingScope.value === "all") {
                    for (let i=0;i<count;i++) {
                        const w=panels[i].frame.contentWindow;
                        if (restoreAnnotations[i] && typeof w.__mpSetAnnotations === "function") w.__mpSetAnnotations(restoreAnnotations[i]);
                    }
                }
                const images = await Promise.all(captures.map(src => new Promise((resolve, reject) => {
                    const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src;
                })));
                const cols = count === 1 ? 1 : 2;
                const rows = count === 4 ? 2 : 1;
                const gap = 8;
                const headerH = 92;
                const panelW = 1920;
                const panelH = Math.max(...images.map(img => Math.round(panelW * img.height / img.width)));
                const outW = cols * panelW + (cols - 1) * gap;
                const outH = headerH + rows * panelH + (rows - 1) * gap;
                const out = document.createElement("canvas"); out.width = outW; out.height = outH;
                const ctx = out.getContext("2d", { alpha: false });
                ctx.fillStyle = "#102433"; ctx.fillRect(0, 0, outW, headerH);
                ctx.fillStyle = "#d7e7f2"; ctx.font = '600 25px Inter, "Segoe UI", Arial, sans-serif'; ctx.textBaseline = "middle"; ctx.textAlign = "left";
                ctx.fillText("Visualization & Viewer Developed by: Matthew Labenz · NWS North Platte, NE", 42, headerH / 2);
                ctx.fillStyle = "#ffffff"; ctx.font = '700 29px Inter, "Segoe UI", Arial, sans-serif'; ctx.textAlign = "right";
                ctx.fillText(`${count}-Panel · 3-km Mesoscale Analysis Data`, outW - 42, headerH / 2);
                images.forEach((img, i) => {
                    const col = count === 1 ? 0 : i % 2, row = count === 4 ? Math.floor(i / 2) : 0;
                    const x = col * (panelW + gap), y = headerH + row * (panelH + gap);
                    ctx.fillStyle = "#ffffff"; ctx.fillRect(x, y, panelW, panelH);
                    const h = Math.round(panelW * img.height / img.width);
                    ctx.drawImage(img, x, y, panelW, h);
                    ctx.strokeStyle = i === activePanel ? "#2f9be8" : "#425766"; ctx.lineWidth = 5; ctx.strokeRect(x + 2.5, y + 2.5, panelW - 5, panelH - 5);
                    ctx.fillStyle = "rgba(13,27,39,.9)"; ctx.fillRect(x + 14, y + 14, 122, 42);
                    ctx.fillStyle = "#fff"; ctx.font = '700 21px Inter, Arial, sans-serif'; ctx.textAlign = "center"; ctx.fillText(`Panel ${i + 1}`, x + 75, y + 35);
                });
                const blob = await new Promise(resolve => out.toBlob(resolve, "image/png"));
                if (!blob) throw new Error("PNG encoding failed.");
                const url = URL.createObjectURL(blob), a = document.createElement("a");
                const label = (document.getElementById("timeline-time-label")?.textContent || "analysis").replace(/[^0-9A-Za-z]+/g, "_");
                a.href = url; a.download = `3km_Mesoscale_Analysis_${count}Panel_${label}.png`; document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1500);
            } catch (err) {
                console.error("Combined PNG export failed:", err);
                alert(`Combined PNG export failed: ${err.message || err}`);
            } finally {
                savePng.disabled = false; savePng.textContent = old || "Save PNG";
            }
        }

        setInterval(() => { syncHostFromActiveChild(); syncTimeFromActiveChild(); if (drawingScope.value === "all") renderSharedOverlay(); }, 350);
        applyLayout(layoutSelect ? layoutSelect.value : 1);
        if (saveGif) saveGif.title = "GIF export uses the active panel. PNG export combines all visible panels.";
    })();
} else {
    document.body.classList.add("mp-child");

"use strict";

/* =========================================================================================
   SPCOA MESOANALYSIS VIEWER
   =========================================================================================

   FILLED FIELDS
     - SBCAPE
     - MLCAPE
     - MUCAPE
     - 0–3 km MLCAPE
     - Surface Dewpoint
     - 2 m Equivalent Potential Temperature
     - 2 m Relative Humidity
     - 925/850/700/500/250 mb Relative Humidity

   INDEPENDENT VECTOR OVERLAYS
     - Surface Wind Barbs
     - 0–2 km Storm-Relative Wind Barbs
     - 4–6 km Storm-Relative Wind Barbs
     - 9–11 km Storm-Relative Wind Barbs
     - Effective Storm-Relative Wind Barbs
     - Anvil-Level Storm-Relative Wind Barbs
     - 0–1 km Bulk Shear Barbs
     - 0–3 km Bulk Shear Barbs
     - 0–6 km Bulk Shear Barbs
     - 0–8 km Bulk Shear Barbs
     - Effective Bulk Shear Barbs
     - Bunkers Right-Mover Storm Motion Barbs
     - Bunkers Left-Mover Storm Motion Barbs
     - 0–6 km Mean Wind Barbs
     - MU LCL–EL Mean Wind Barbs
     - 925 mb Wind Barbs
     - 850 mb Wind Barbs
     - 700 mb Wind Barbs
     - 500 mb Wind Barbs
     - 250 mb Wind Barbs

   INDEPENDENT CONTOUR OVERLAYS
     - Surface MSLP
     - DCAPE
     - Warm Cloud Depth
     - 925 mb Geopotential Height
     - 850 mb Geopotential Height
     - 700 mb Geopotential Height
     - 500 mb Geopotential Height
     - 250 mb Geopotential Height

   RENDERING
     - Full-resolution scalar canvas
     - Bilinear numerical interpolation
     - Numerical canvas follows camera during pan/zoom
     - Fresh numerical redraw after movement ends
     - MSLP numerical contours every 2 hPa
     - DCAPE numerical contours every 200 J/kg beginning at 100 J/kg
     - Warm Cloud Depth numerical contours every 250 m beginning at 250 m
     - 925/850/700/500 mb height contours every 30 m
     - 250 mb height contours every 60 m
     - WCD and geopotential heights use backend-smoothed numerical fields
     - Geopotential height contours and labels are fixed black
     - Height labels use a light white halo
     - MSLP/DCAPE/WCD/height labels rendered separately above geography

   CANVAS STACK
     vector-canvas          z = 7
     contour-label-canvas   z = 6
     geography-canvas       z = 5
     contour-canvas         z = 4
     weather-canvas         z = 2
     MapLibre

   Numerical tiles are read directly from AWS S3.
   ========================================================================================= */


/* =========================================================================================
   AWS
   ========================================================================================= */

const S3_BASE_URL =
    "https://spcoa-mesoanalysis.s3.us-east-2.amazonaws.com/spcoa";


/* =========================================================================================
   TILE SETTINGS
   ========================================================================================= */

const TILE_SIZE = 256;

const SCALAR_NODATA = 65535;

const VECTOR_NODATA = -32768;


/* =========================================================================================
   SECTORS
   ========================================================================================= */

const sectors = {

    lbf: {
        name: "LBF CWA",
        bounds: [
            [-103.4, 39.8],
            [-98.6, 43.3]
        ]
    },

    regional: {
        name: "LBF Regional",
        bounds: [
            [-106.0, 38.0],
            [-96.0, 45.0]
        ]
    },

    nebraska: {
        name: "Nebraska",
        bounds: [
            [-104.7, 39.4],
            [-95.0, 43.6]
        ]
    },

    northern_plains: {
        name: "Northern Plains",
        bounds: [
            [-107.5, 39.5],
            [-94.0, 49.5]
        ]
    },

    central_plains: {
        name: "Central Plains",
        bounds: [
            [-106.5, 34.0],
            [-91.0, 45.5]
        ]
    },

    southern_plains: {
        name: "Southern Plains",
        bounds: [
            [-106.5, 25.0],
            [-93.0, 38.5]
        ]
    },

    high_plains: {
        name: "High Plains",
        bounds: [
            [-108.5, 28.0],
            [-97.0, 49.5]
        ]
    },

    midwest: {
        name: "Midwest",
        bounds: [
            [-104.0, 35.0],
            [-80.0, 49.5]
        ]
    },

    rockies: {
        name: "Rockies",
        bounds: [
            [-116.0, 30.0],
            [-101.0, 49.5]
        ]
    },

    conus: {
        name: "CONUS",
        bounds: [
            [-125.0, 24.0],
            [-66.0, 50.0]
        ]
    }

};


/* =========================================================================================
   CAPE COLOR TABLE
   ========================================================================================= */

/* CIN shading: exact user-provided boundaries and colors. */
const CIN_BOUNDS = [-1050, -1000, -950, -900, -850, -800, -750, -700, -650, -600, -580, -560, -540, -520, -500, -480, -460, -440, -420, -400, -380, -360, -340, -320, -300, -280, -260, -240, -220, -200, -190, -180, -170, -160, -150, -140, -130, -120, -110, -100, -95, -80, -75, -70, -65, -60, -55, -50, -47.5, -45, -42.5, -40, -37.5, -35, -32.5, -30, -27.5, -25, -22.5, -20, -17.5, -15, -12.5, -10, -7.5, -5, -2.5, 0];
const CIN_COLORS = ["#b99295", "#b2878c", "#ab7d83", "#a57279", "#9e6970", "#985e66", "#91545c", "#8a4953", "#844049", "#ac485b", "#b25667", "#b86272", "#be707e", "#c57c8a", "#cc8a95", "#d297a1", "#d9a4ad", "#dfb1b7", "#e6bfc3", "#d79ae6", "#cc8adc", "#c07ad1", "#b56ac7", "#a95bbd", "#9e4ab2", "#923aa8", "#872b9e", "#7b1c93", "#700e89", "#861550", "#8e1a4a", "#971f44", "#9f253d", "#a82b37", "#b13131", "#b9362b", "#c23d27", "#cb4323", "#d3491f", "#d9731c", "#da7e24", "#dc8a2f", "#dd963c", "#dfa24b", "#dfae5a", "#e1b96a", "#e3c679", "#e4d289", "#e6de99", "#abc7ce", "#9fbac2", "#92adb7", "#86a0ac", "#7993a1", "#6d8695", "#60798a", "#546c7f", "#475f74", "#3b5269", "#696969", "#787878", "#878787", "#969696", "#a5a5a5", "#c3c3c3", "#d2d2d2", "#e1e1e1", "#f0f0f0", "#ffffff"];
const CIN_RGB = CIN_COLORS.map(hexToRgb);
function getCinColor(value) {
    if (!Number.isFinite(value)) return null;
    let bin = 0;
    while (bin < CIN_BOUNDS.length - 2 && value >= CIN_BOUNDS[bin + 1]) bin++;
    // Matplotlib BoundaryNorm distributes 67 intervals across 69 colors.
    const index = Math.floor(bin * (CIN_COLORS.length - 1) / (CIN_BOUNDS.length - 2));
    return CIN_RGB[Math.min(CIN_RGB.length - 1, index)];
}
// Equivalent to the backend's matplotlib Blues sampling, darker for more-negative CIN.
const CIN_BLUES_LEVELS = Array.from({length: 40}, (_, i) => -1000 + i * 25);
const CIN_BLUES_COLORS = ["#083c7d", "#084285", "#08468b", "#084b93", "#084f99", "#0a549e", "#0e58a2", "#125da6", "#1561a9", "#1966ad", "#1c6ab0", "#206fb4", "#2373b6", "#2979b9", "#2d7dbb", "#3181bd", "#3686c0", "#3a8ac2", "#3f8fc5", "#4493c7", "#4a98c9", "#4f9bcb", "#56a0ce", "#5ba3d0", "#61a7d2", "#66abd4", "#6dafd7", "#74b3d8", "#7cb7da", "#82bbdb", "#8abfdd", "#91c3de", "#99c7e0", "#9fcae1", "#a5cde3", "#aacfe5", "#b0d2e7", "#b5d4e9", "#bcd7eb", "#c1d9ed"];
function getCinBluesColor(level) {
    const idx = Math.round((level + 1000) / 25);
    if (idx >= 0 && idx < CIN_BLUES_COLORS.length && Math.abs(level - CIN_BLUES_LEVELS[idx]) < 0.01) return CIN_BLUES_COLORS[idx];
    const t = Math.max(0, Math.min(1, 0.25 + 0.70 * (-level / 1000)));
    // Matplotlib Blues lookup table, interpolated at 256-sample resolution.
    const stops = [[0,'#f7fbff'],[.125,'#deebf7'],[.25,'#c6dbef'],[.375,'#9ecae1'],[.5,'#6baed6'],[.625,'#4292c6'],[.75,'#2171b5'],[.875,'#08519c'],[1,'#08306b']];
    let j = 0; while (j < stops.length - 2 && t > stops[j+1][0]) j++;
    const w = (t - stops[j][0]) / (stops[j+1][0]-stops[j][0]);
    const a = hexToRgb(stops[j][1]), b = hexToRgb(stops[j+1][1]);
    return '#' + a.map((v,i)=>Math.round(v+(b[i]-v)*w).toString(16).padStart(2,'0')).join('');
}

const CAPE_BOUNDS = [
    0,100,200,300,400,500,600,700,800,900,
    1000,1100,1200,1300,1400,1500,1600,1700,1800,1900,
    2000,2100,2200,2300,2400,2500,2600,2700,2800,2900,
    3000,3100,3200,3300,3400,3500,3600,3700,3800,3900,
    4000,4100,4200,4300,4400,4500,4600,4700,4800,4900,
    5000,5100,5200,5300,5400,5500,5600,5700,5800,5900,
    6000,6500,7000,7500,8000,8500,9000,9500,10000,10500
];

const CAPE_COLORS = [
    "#ffffff","#f0f0f0","#e1e1e1","#d2d2d2","#c3c3c3",
    "#a5a5a5","#969696","#878787","#787878","#696969",
    "#3b5269","#475f74","#546c7f","#60798a","#6d8695",
    "#7993a1","#86a0ac","#92adb7","#9fbac2","#abc7ce",
    "#e6de99","#e4d289","#e3c679","#e1b96a","#dfae5a",
    "#dfa24b","#dd963c","#dc8a2f","#da7e24","#d9731c",
    "#d3491f","#cb4323","#c23d27","#b9362b","#b13131",
    "#a82b37","#9f253d","#971f44","#8e1a4a","#861550",
    "#700e89","#7b1c93","#872b9e","#923aa8","#9e4ab2",
    "#a95bbd","#b56ac7","#c07ad1","#cc8adc","#d79ae6",
    "#e6bfc3","#dfb1b7","#d9a4ad","#d297a1","#cc8a95",
    "#c57c8a","#be707e","#b86272","#b25667","#ac485b",
    "#844049","#8a4953","#91545c","#985e66","#9e6970",
    "#a57279","#ab7d83","#b2878c","#b99295"
];

const CAPE_03KM_BOUNDS =
    Array.from(
        { length: 61 },
        (_, index) => index * 10
    );

const CAPE_03KM_COLORS =
    CAPE_COLORS.slice(0, 61);

const DCAPE_BOUNDS = [
    100, 300, 500, 700,
    900, 1100, 1300,
    1500, 1700, 1900, 2100
];

const DCAPE_COLORS = [
    "#f5a623",  // 100
    "#f39a1e",  // 300
    "#ef7d16",  // 500
    "#ea5b1b",  // 700
    "#df3024",  // 900
    "#c41624",  // 1100
    "#ae111f",  // 1300
    "#950e19",  // 1500
    "#7f0b15",  // 1700
    "#680912",  // 1900
    "#52070e"   // 2100+
];

const WCD_BOUNDS = [
    0, 250, 500, 750, 1000,
    1250, 1500, 1750, 2000,
    2250, 2500, 2750, 3000,
    3250, 3500, 3750, 4000,
    4250, 4500, 4750, 5000
];

const WCD_COLORS = [
    "#7a0177",
    "#9e0168",
    "#c51b5a",
    "#de2d26",
    "#ef4b2c",
    "#f46d43",
    "#f98e52",
    "#fdae61",
    "#fdd36a",
    "#fee08b",
    "#e6f598",
    "#bfe57a",
    "#8bd17c",
    "#5abf90",
    "#35a7a5",
    "#3288bd",
    "#3973b7",
    "#4855a5",
    "#55358f",
    "#542788"
];


/* =========================================================================================
   LCL HEIGHT / PWAT COLOR TABLES
   ========================================================================================= */

const LCL_BOUNDS = [
    250, 500, 750, 1000, 1250, 1500,
    1750, 2000, 2250, 2500, 2750, 3000,
    3250, 3500, 3750, 4000
];

const LCL_COLORS = [
    "#087f23", "#15952d", "#29aa38", "#47bd43",
    "#70ca4b", "#a7d653", "#d6db57", "#e6cf4d",
    "#e5b84b", "#d99642", "#c47a3a", "#9a5b32",
    "#89502d", "#774429", "#653824", "#532d20"
];

/*
 * Precipitable Water (inches)
 * Exact palette supplied for 0.00–3.00 inches at 0.05-inch intervals.
 */
const PWAT_BOUNDS =
    Array.from({ length: 61 }, (_, index) => index * 0.05);

const PWAT_COLORS = [
    "#423921", "#524a32", "#625a43", "#726b53", "#827c64", "#918c75", "#a19d86", "#b1ad96",
    "#c1bea7", "#bce4ba", "#a8d3a6", "#96c293", "#82b27f", "#6fa16b", "#5c9058", "#497f44", "#366f31",
    "#245e1e", "#144d0c", "#6aa2ae", "#60959f", "#588891", "#4e7a82", "#456d73", "#3c6066", "#325357",
    "#294648", "#20393a", "#162c2b", "#686699", "#625e93", "#5b568d",
    "#554e87", "#4f4681", "#483e7b", "#423675", "#3c2e6f", "#352669", "#2f1d63", "#704271",
    "#764774", "#7a4d75", "#805277", "#855879", "#8b5d7a", "#90637c", "#96687e", "#9b6e7f", "#a17381",
    "#c5988d", "#caa194", "#ceaa9c", "#d4b3a3", "#d8bcab", "#ddc5b2", "#e1cdba", "#e7d6c1", "#ebdec9",
    "#f0e7d0", "#f0e7d0"
];

if (PWAT_COLORS.length !== PWAT_BOUNDS.length - 1) {
    throw new Error("PWAT palette mismatch: colors must equal bounds minus one.");
}


/* =========================================================================================
   SIGNIFICANT TORNADO PARAMETER (EFFECTIVE-LAYER) COLOR TABLE
   ========================================================================================= */

const STP_BOUNDS = [
    0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9,
    1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9,
    2.0, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9,
    3.0, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9,
    4.0, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9,
    5.0, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9,
    6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0, 10.5
];

const STP_COLORS = [
    "#ffffff", "#f0f0f0", "#e1e1e1", "#d2d2d2", "#c3c3c3",
    "#a5a5a5", "#969696", "#878787", "#787878", "#696969",
    "#3b5269", "#475f74", "#546c7f", "#60798a", "#6d8695",
    "#7993a1", "#86a0ac", "#92adb7", "#9fbac2", "#abc7ce",
    "#e6de99", "#e4d289", "#e3c679", "#e1b96a", "#dfae5a",
    "#dfa24b", "#dd963c", "#dc8a2f", "#da7e24", "#d9731c",
    "#d3491f", "#cb4323", "#c23d27", "#b9362b", "#b13131",
    "#a82b37", "#9f253d", "#971f44", "#8e1a4a", "#861550",
    "#700e89", "#7b1c93", "#872b9e", "#923aa8", "#9e4ab2",
    "#a95bbd", "#b56ac7", "#c07ad1", "#cc8adc", "#d79ae6",
    "#e6bfc3", "#dfb1b7", "#d9a4ad", "#d297a1", "#cc8a95",
    "#c57c8a", "#be707e", "#b86272", "#b25667", "#ac485b",
    "#844049", "#8a4953", "#91545c", "#985e66", "#9e6970",
    "#a57279", "#ab7d83", "#b2878c", "#b99295"
];

if (STP_COLORS.length !== STP_BOUNDS.length - 1) {
    throw new Error("STP palette mismatch: colors must equal bounds minus one.");
}


/* =========================================================================================
   PRESSURE-LEVEL FILLED WIND-SPEED COLOR TABLES
   ========================================================================================= */

const MIDLEVEL_WIND_BOUNDS =
    Array.from({ length: 62 }, (_, index) => 20 + index);

const MIDLEVEL_WIND_COLORS = [
    "#f1f8ff", "#def0fd", "#cae6fc", "#b7defb", "#a4d5fa", "#92cdf8",
    "#8ab6ef", "#839fe6", "#7c87dd", "#7570d4", "#6e59cb", "#8566ce",
    "#9c72d1", "#b27fd5", "#ca8bd8", "#e298db", "#dc8cd5", "#d580cf",
    "#cf74c9", "#c969c3", "#c35dbd", "#bb4fb5", "#b342ad", "#ab35a5",
    "#a3289d", "#9b1d95", "#a21c80", "#a91c6a", "#b11c55", "#b81c41",
    "#c01c2e", "#c42032", "#c72435", "#cb2939", "#cf2e3d", "#d33441",
    "#d73b45", "#db4249", "#df494c", "#e35050", "#e75754", "#e97559",
    "#ec935d", "#efb262", "#f3d167", "#f7f16b", "#f0e765", "#eadd60",
    "#e4d35a", "#dec954", "#d8bf4e", "#d1b548", "#cbab42", "#c5a13c",
    "#bf9737", "#b98e31", "#b3842b", "#ad7a26", "#a77021", "#a1661c",
    "#9b5c17"
];

const WIND_500_BOUNDS =
    Array.from({ length: 122 }, (_, index) => 20 + index);

const WIND_500_COLORS = [
    "#f1f8ff", "#e8f4ff", "#def0fd", "#d4eafd", "#cae6fc", "#c1e2fc",
    "#b7defb", "#aedafb", "#a4d5fa", "#9bd1fa", "#92cdf8", "#8ec1f4",
    "#8ab6ef", "#86aaeb", "#839fe6", "#8093e2", "#7c87dd", "#797cd9",
    "#7570d4", "#7165d0", "#6e59cb", "#795fcd", "#8566ce", "#906cd0",
    "#9c72d1", "#a778d4", "#b27fd5", "#bf85d7", "#ca8bd8", "#d691da",
    "#e298db", "#df92d8", "#dc8cd5", "#d986d2", "#d580cf", "#d27acc",
    "#cf74c9", "#cc6ec6", "#c969c3", "#c663c0", "#c35dbd", "#bf56b9",
    "#bb4fb5", "#b749b1", "#b342ad", "#af3ba9", "#ab35a5", "#a72fa1",
    "#a3289d", "#9f2299", "#9b1d95", "#9f1c8a", "#a21c80", "#a61c75",
    "#a91c6a", "#ad1c60", "#b11c55", "#b41c4b", "#b81c41", "#bc1c37",
    "#c01c2e", "#c21e30", "#c42032", "#c52233", "#c72435", "#c92637",
    "#cb2939", "#cd2b3b", "#cf2e3d", "#d1313f", "#d33441", "#d53843",
    "#d73b45", "#d93e47", "#db4249", "#dd454a", "#df494c", "#e14c4e",
    "#e35050", "#e55452", "#e75754", "#e86656", "#e97559", "#eb845b",
    "#ec935d", "#eea35f", "#efb262", "#f1c264", "#f3d167", "#f5e169",
    "#f7f16b", "#f3ec68", "#f0e765", "#ede262", "#eadd60", "#e7d85d",
    "#e4d35a", "#e1ce57", "#dec954", "#dbc451", "#d8bf4e", "#d4ba4b",
    "#d1b548", "#ceb045", "#cbab42", "#c8a63f", "#c5a13c", "#c29c39",
    "#bf9737", "#bc9334", "#b98e31", "#b6892e", "#b3842b", "#b07f29",
    "#ad7a26", "#aa7523", "#a77021", "#a46b1e", "#a1661c", "#9e6119",
    "#9b5c17"
];

const WIND_250_BOUNDS =
    Array.from({ length: 122 }, (_, index) => 50 + index);

const WIND_250_COLORS = [
    "#f1f8ff", "#e8f4ff", "#def0fd", "#d4eafd", "#cae6fc", "#c1e2fc",
    "#b7defb", "#aedafb", "#a4d5fa", "#9bd1fa", "#92cdf8", "#8ec1f4",
    "#8ab6ef", "#86aaeb", "#839fe6", "#8093e2", "#7c87dd", "#797cd9",
    "#7570d4", "#7165d0", "#6e59cb", "#795fcd", "#8566ce", "#906cd0",
    "#9c72d1", "#a778d4", "#b27fd5", "#bf85d7", "#ca8bd8", "#d691da",
    "#e298db", "#df92d8", "#dc8cd5", "#d986d2", "#d580cf", "#d27acc",
    "#cf74c9", "#cc6ec6", "#c969c3", "#c663c0", "#c35dbd", "#bf56b9",
    "#bb4fb5", "#b749b1", "#b342ad", "#af3ba9", "#ab35a5", "#a72fa1",
    "#a3289d", "#9f2299", "#9b1d95", "#9f1c8a", "#a21c80", "#a61c75",
    "#a91c6a", "#ad1c60", "#b11c55", "#b41c4b", "#b81c41", "#bc1c37",
    "#c01c2e", "#c21e30", "#c42032", "#c52233", "#c72435", "#c92637",
    "#cb2939", "#cd2b3b", "#cf2e3d", "#d1313f", "#d33441", "#d53843",
    "#d73b45", "#d93e47", "#db4249", "#dd454a", "#df494c", "#e14c4e",
    "#e35050", "#e55452", "#e75754", "#e86656", "#e97559", "#eb845b",
    "#ec935d", "#eea35f", "#efb262", "#f1c264", "#f3d167", "#f5e169",
    "#f7f16b", "#f3ec68", "#f0e765", "#ede262", "#eadd60", "#e7d85d",
    "#e4d35a", "#e1ce57", "#dec954", "#dbc451", "#d8bf4e", "#d4ba4b",
    "#d1b548", "#ceb045", "#cbab42", "#c8a63f", "#c5a13c", "#c29c39",
    "#bf9737", "#bc9334", "#b98e31", "#b6892e", "#b3842b", "#b07f29",
    "#ad7a26", "#aa7523", "#a77021", "#a46b1e", "#a1661c", "#9e6119",
    "#9b5c17"
];



/* =========================================================================================
   DEWPOINT COLOR TABLE
   ========================================================================================= */

const DEWPOINT_COLORS = [
    "#946e4f","#926d4e","#906c4e","#8e6b4d","#8c6a4d","#8b694c",
    "#89674c","#87664b","#85654a","#83644a","#816349","#7f6249",
    "#7d6147","#7b6047","#795f46","#775e45","#755c45","#735b44",
    "#715a44","#705943","#6f5843","#6d5742","#6b5641","#695541",
    "#675440","#655340","#63513f","#61503e","#5f4f3e","#5d4e3d",
    "#5b4c3d","#594b3c","#574a3c","#56493b","#54483a","#52473a",
    "#504539","#4e4439","#4c4338","#4a4237","#484136","#4c4335",
    "#504739","#554c3d","#595042","#5d5546","#61594a","#665e4e",
    "#6a6252","#6e6756","#736b5b","#77705f","#7b7463","#7f7967",
    "#847d6b","#888270","#8c8674","#918b78","#958f7c","#999480",
    "#9d9884","#a29d89","#a6a18d","#aaa691","#aeaa95","#b3af99",
    "#b7b39d","#bbb8a2","#c0bca6","#c4c1aa","#c8c5ae","#cccab2",
    "#d1ceb7","#d5d3bb","#d9d7bf","#dedcc3","#e2e0c7","#e6e5cb",
    "#eae9d0","#efeed4","#f3f2d8","#e7f5e6","#d9f0d7","#caeac9",
    "#bce4ba","#aedeab","#a0d99c","#92d38d","#84ce7f","#76c870",
    "#69c362","#42ad35","#3da231","#38982c","#338d27","#2d8222",
    "#28781e","#236d19","#1e6215","#195810","#144d0c","#6aa2ae",
    "#60959f","#588891","#4e7a82","#456d73","#3c6066","#325357",
    "#294648","#20393a","#162c2b","#686699","#625e93","#5b568d",
    "#554e87","#4f4681","#483e7b","#423675","#3c2e6f","#352669",
    "#2f1d63","#704170","#754673","#7a4c75","#805176","#855778",
    "#8b5c7a","#90627c","#96677d","#9b6d7f","#a07281"
];



/* =========================================================================================
   THETA-E / RELATIVE HUMIDITY COLOR TABLES
   ========================================================================================= */

/* 131 one-Kelvin theta-e bins spanning 239 through 370 K. */
const THETAE_BOUNDS =
    Array.from({ length: 132 }, (_, index) => 239 + index);

const THETAE_COLORS = [
    "#946e4f", "#926d4e", "#906c4e", "#8e6b4d", "#8c6a4d", "#8b694c", "#89674c", "#87664b", "#85654a", "#83644a", "#816349", "#7f6249", "#7d6147", "#7b6047", "#795f46", "#775e45", "#755c45", "#735b44", "#715a44", "#705943", "#6f5843", "#6d5742", "#6b5641", "#695541", "#675440", "#655340", "#63513f", "#61503e", "#5f4f3e", "#5d4e3d", "#5b4c3d", "#594b3c", "#574a3c", "#56493b", "#54483a", "#52473a", "#504539", "#4e4439", "#4c4338", "#4a4237", "#484136", "#4c4335", "#504739", "#554c3d", "#595042", "#5d5546", "#61594a", "#665e4e", "#6a6252", "#6e6756", "#736b5b", "#77705f", "#7b7463", "#7f7967", "#847d6b", "#888270", "#8c8674", "#918b78", "#958f7c", "#999480", "#9d9884", "#a29d89", "#a6a18d", "#aaa691", "#aeaa95", "#b3af99", "#b7b39d", "#bbb8a2", "#c0bca6", "#c4c1aa", "#c8c5ae", "#cccab2", "#d1ceb7", "#d5d3bb", "#d9d7bf", "#dedcc3", "#e2e0c7", "#e6e5cb", "#eae9d0", "#efeed4", "#f3f2d8", "#e7f5e6", "#d9f0d7", "#caeac9", "#bce4ba", "#aedeab", "#a0d99c", "#92d38d", "#84ce7f", "#76c870", "#69c362", "#42ad35", "#3da231", "#38982c", "#338d27", "#2d8222", "#28781e", "#236d19", "#1e6215", "#195810", "#144d0c", "#6aa2ae", "#60959f", "#588891", "#4e7a82", "#456d73", "#3c6066", "#325357", "#294648", "#20393a", "#162c2b", "#686699", "#625e93", "#5b568d", "#554e87", "#4f4681", "#483e7b", "#423675", "#3c2e6f", "#352669", "#2f1d63", "#704170", "#754673", "#7a4c75", "#805176", "#855778", "#8b5c7a", "#90627c", "#96677d", "#9b6d7f", "#a07281"
];

/*
 * RH palette supplied by Matthew. The original Matplotlib definition has
 * boundaries -1..100 and 103 colors. BoundaryNorm is allowed to have more
 * colors than bins, so the browser lookup below reproduces that behavior
 * by spreading the 101 RH intervals across the complete 103-color palette.
 */
const RH_BOUNDS =
    Array.from({ length: 102 }, (_, index) => -1 + index);

const RH_COLORS = [
    "#a1744f", "#966d4b", "#8b6648", "#816044", "#765940", "#6c523c", "#624b38", "#574434", "#4c3d30", "#42362d", "#372f28", "#3b352a", "#413a2f", "#464035", "#4c453a", "#514b3f", "#575044", "#5c554a", "#625b4f", "#676054", "#6d6559", "#736b5f", "#787064", "#7e766a", "#837b6f", "#898074", "#8e867a", "#948b7f", "#999084", "#9f968a", "#a49b8f", "#aaa195", "#b0a69a", "#b5ab9f", "#bbb1a4", "#c0b6aa", "#c6bbaf", "#cbc1b4", "#d1c6b9", "#d6ccbf", "#dcd1c4", "#c9d7c0", "#c5d4bd", "#c1d1ba", "#bdceb7", "#b9cbb4", "#b5c9b1", "#b1c6ae", "#adc3ab", "#a9c0a8", "#a5bda5", "#a1baa2", "#9db79f", "#99b49c", "#95b29a", "#92af97", "#8eac94", "#8aa991", "#86a68e", "#82a38b", "#7d9f88", "#799c85", "#769a82", "#72977f", "#6e947c", "#6a9179", "#668e76", "#628b73", "#5f8870", "#5b856d", "#57836a", "#538067", "#4f7d64", "#4b7a61", "#47775e", "#43745b", "#407158", "#3c6e55", "#386c53", "#356950", "#31664d", "#2e634a", "#2a6047", "#275d44", "#235a41", "#1f573e", "#1c553b", "#195238", "#164f35", "#164f35", "#134c32", "#10492f", "#0c4023", "#11422e", "#144538", "#184743", "#1b494d", "#1f4c57", "#234e61", "#27506c", "#2b5276", "#2f5581", "#33578b"
];



/* =========================================================================================
   2-M TEMPERATURE COLOR TABLE
   WeatherBell-style palette from Model_4Panel_Forcing.ipynb.
   230 one-degree Fahrenheit bins: -100 through 130 °F.
   ========================================================================================= */

const TEMPERATURE_BOUNDS =
    Array.from({ length: 231 }, (_, index) => -100 + index);

const TEMPERATURE_COLORS = [
    "#3f0390", "#46038f", "#4e038e", "#55038e", "#5d038d", "#64038c", "#6b038b", "#73038a", "#7a0389", "#810489", "#890488", "#900487", "#980486", "#9f0485", "#a60484", "#ae0484", "#b50483", "#bc0482", "#c00984", "#c50e87", "#c91389", "#cd188b", "#d11d8e", "#d52290", "#d92792", "#de2b94", "#e23097", "#e63599", "#ea3a9b", "#ee3f9e", "#f244a0", "#f749a2", "#fa4ea5", "#f854a8", "#f65aab", "#f461ae", "#f267b1", "#f06db4", "#ee73b7", "#ec79bb", "#ea7fbe", "#e886c1", "#e68cc4", "#e392c7", "#e198ca", "#df9ece", "#dda5d1", "#dbaad3", "#d7add5", "#d4b1d6", "#d0b4d8", "#cdb8d9", "#c9bbda", "#c6bfdc", "#c2c2dd", "#bfc6de", "#bbc9e0", "#b8cde1", "#b4d0e3", "#b1d4e4", "#add7e5", "#aadae7", "#a6dee8", "#a3e1e9", "#9fe5eb", "#9ce8ec", "#98ecee", "#95efef", "#90f0ee", "#88e6e4", "#80dbd9", "#78d1cf", "#70c7c5", "#67bdbb", "#5fb2b0", "#57a8a6", "#4f9e9c", "#479492", "#3f8987", "#367f7d", "#2e7573", "#266b69", "#1e605e", "#165654", "#165452", "#235c5b", "#306563", "#3d6e6c", "#4a7775", "#577f7e", "#648887", "#719190", "#7e9999", "#8ba2a1", "#98abaa", "#a5b4b3", "#b2bcbc", "#bfc5c5", "#cccece", "#897fb9", "#371e9a", "#3e1f93", "#46208c", "#4d2185", "#55227e", "#5c2376", "#64246f", "#6b2568", "#732561", "#7a265a", "#822753", "#89284c", "#902944", "#982a3d", "#9f2b36", "#a72c2f", "#ad3333", "#b23e3e", "#b64a4a", "#bb5656", "#c06161", "#c56d6d", "#ca7979", "#ce8484", "#d39090", "#d89c9c", "#dda7a7", "#e2b3b3", "#e6bfbf", "#ebcaca", "#f0d6d6", "#f5e2e2", "#eee6e7", "#dce5e8", "#cbe3e9", "#bae1ea", "#a9e0eb", "#9ed9e7", "#97cddf", "#91c2d8", "#8bb6d0", "#84abc8", "#7e9fc1", "#7793b9", "#7188b2", "#6b7caa", "#6471a2", "#5e659b", "#585a93", "#5e5e8f", "#6e6e8c", "#7d7d8a", "#8d8d88", "#9c9c86", "#acac84", "#bbbb82", "#cbcb7f", "#dada7d", "#eaea7b", "#f9f979", "#fcf875", "#f6ee70", "#f0e36b", "#ebd866", "#e5ce61", "#dfc35c", "#d9b857", "#d4ad52", "#cea34d", "#c89848", "#c38d43", "#bd833d", "#b77838", "#b26d33", "#ac632e", "#a65829", "#a14d24", "#9b421f", "#95381a", "#902d15", "#8a2210", "#84180b", "#7f0d06", "#790201", "#740807", "#6e120f", "#691c17", "#64261f", "#6b332b", "#743f38", "#7d4c44", "#865951", "#8e655d", "#97726a", "#a07f76", "#a98b83", "#b2988f", "#bba59c", "#b9a19a", "#b59b95", "#b19490", "#ad8d8c", "#a98787", "#a58082", "#a1797d", "#9d7278", "#996c74", "#95656f", "#915e6a", "#8d5865", "#895161", "#854a5c", "#824357", "#7e3d52", "#7a364d", "#762f49", "#722944", "#693144", "#603943", "#574043", "#4f4843", "#464f42", "#3d5742", "#345e42", "#2c6642", "#236e41", "#1a7541", "#117d41", "#098440", "#008c40"
];

/* =========================================================================================
   PRESSURE-LEVEL TEMPERATURE COLOR TABLE

   WeatherBell-style split palette selected for 925/850/700/500/250 mb temperature.

   -50 to 0 C : 1 C bins, cold side of the WeatherBell palette ending in gray at 0 C.
     0 to 40 C: 0.2 C bins, warm side begins with dark purple exactly at 0 C.

   The map colors are sampled by actual temperature coordinate so increasing the warm-side
   resolution does not move the 0 C transition.
   ========================================================================================= */

const PRESSURE_TEMPERATURE_CONTROL_POINTS = [
    [0.000, "#3f0390"], [0.074, "#bc0482"], [0.139, "#fa4da4"],
    [0.204, "#dca9d3"], [0.296, "#92f2f0"], [0.365, "#11504e"],
    [0.430, "#d2d2d2"], [0.435, "#341e9d"], [0.504, "#aa2c2c"],
    [0.574, "#f7e7e7"], [0.596, "#a1dfeb"], [0.648, "#555590"],
    [0.696, "#ffff78"], [0.800, "#780000"], [0.817, "#632720"],
    [0.861, "#bca79e"], [0.943, "#722944"], [1.000, "#008c40"]
];

function interpolateHexColor(colorA, colorB, fraction) {
    const a = hexToRgb(colorA);
    const b = hexToRgb(colorB);
    const f = Math.max(0, Math.min(1, fraction));
    const channel = key => Math.round(a[key] + (b[key] - a[key]) * f);
    return `rgb(${channel("r")}, ${channel("g")}, ${channel("b")})`;
}

function samplePressureTemperatureMaster(position) {
    const p = Math.max(0, Math.min(1, position));
    for (let i = 0; i < PRESSURE_TEMPERATURE_CONTROL_POINTS.length - 1; i++) {
        const [p0, c0] = PRESSURE_TEMPERATURE_CONTROL_POINTS[i];
        const [p1, c1] = PRESSURE_TEMPERATURE_CONTROL_POINTS[i + 1];
        if (p >= p0 && p <= p1) {
            return interpolateHexColor(c0, c1, p1 === p0 ? 0 : (p - p0) / (p1 - p0));
        }
    }
    return PRESSURE_TEMPERATURE_CONTROL_POINTS.at(-1)[1];
}

const PRESSURE_TEMPERATURE_BOUNDS = [
    ...Array.from({ length: 51 }, (_, i) => -50 + i),
    ...Array.from({ length: 200 }, (_, i) => Number(((i + 1) * 0.2).toFixed(1)))
];

const PRESSURE_TEMPERATURE_COLORS = (() => {
    const colors = [];
    for (let i = 0; i < PRESSURE_TEMPERATURE_BOUNDS.length - 1; i++) {
        const midpoint = (PRESSURE_TEMPERATURE_BOUNDS[i] + PRESSURE_TEMPERATURE_BOUNDS[i + 1]) / 2;
        let position;
        if (midpoint < 0) {
            const fraction = (midpoint + 50) / 50;
            position = fraction * 0.430;
        } else {
            const fraction = midpoint / 40;
            position = 0.435 + fraction * (1.000 - 0.435);
        }
        colors.push(samplePressureTemperatureMaster(position));
    }
    return colors;
})();

/* =========================================================================================
   PRESSURE-LEVEL TEMPERATURE ADVECTION COLOR TABLE
   Based on the supplied Model_4Panel_Forcing notebook.
   Range: -16 to +16 C / 3 hr in 1-degree bins.
   ========================================================================================= */

const TEMPERATURE_ADVECTION_BOUNDS = [
    ...Array.from({ length: 16 }, (_, i) => -16 + i),
    -0.5, 0.5,
    ...Array.from({ length: 16 }, (_, i) => 1 + i)
];
const TEMPERATURE_ADVECTION_CONTROL_POINTS = [
    [0.00, "#bdb7e8"], [0.05, "#14029c"], [0.30, "#03b6fc"],
    [0.49, "#ffffff"], [0.51, "#ffffff"], [0.70, "#fca503"],
    [0.95, "#b30000"], [1.00, "#fc587f"]
];
function sampleTemperatureAdvectionColor(position) {
    const p = Math.max(0, Math.min(1, position));
    for (let i = 0; i < TEMPERATURE_ADVECTION_CONTROL_POINTS.length - 1; i++) {
        const [p0, c0] = TEMPERATURE_ADVECTION_CONTROL_POINTS[i];
        const [p1, c1] = TEMPERATURE_ADVECTION_CONTROL_POINTS[i + 1];
        if (p >= p0 && p <= p1) return interpolateHexColor(c0, c1, p1 === p0 ? 0 : (p - p0) / (p1 - p0));
    }
    return TEMPERATURE_ADVECTION_CONTROL_POINTS.at(-1)[1];
}
const TEMPERATURE_ADVECTION_COLORS = TEMPERATURE_ADVECTION_BOUNDS.slice(0, -1).map((lower, i) => {
    const midpoint = (lower + TEMPERATURE_ADVECTION_BOUNDS[i + 1]) / 2;
    if (lower >= -0.5 && TEMPERATURE_ADVECTION_BOUNDS[i + 1] <= 0.5) return "#ffffff";
    return sampleTemperatureAdvectionColor((midpoint + 16) / 32);
});

/* =========================================================================================
   LAPSE RATE COLOR TABLE
   Native fields are K/km; displayed as °C/km (numerically identical for lapse rates).
   Exact user-supplied bins, with the 8.3 typo corrected.
   ========================================================================================= */

const LAPSE_RATE_BOUNDS = [
    0, 0.6, 1.2, 1.8, 2.4, 3.0, 3.6, 4.2, 4.8, 5.4, 6.0,
    6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 7.0, 7.1,
    7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 8.0, 8.1, 8.2, 8.3,
    8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 9.0, 9.1, 9.2, 9.3, 9.4, 9.5,
    9.6, 9.7, 9.8, 9.9, 10.0
];

const LAPSE_RATE_COLORS = [
    "#ffffff","#f0f0f0","#e1e1e1","#d2d2d2","#c3c3c3","#a5a5a5","#969696","#878787","#787878","#696969",
    "#3b5269","#475f74","#546c7f","#60798a","#6d8695","#7993a1","#86a0ac","#92adb7","#9fbac2","#abc7ce",
    "#e6de99","#e4d289","#e3c679","#e1b96a","#dfae5a","#dfa24b","#dd963c","#dc8a2f","#da7e24","#d9731c",
    "#d3491f","#cb4323","#c23d27","#b9362b","#b13131","#a82b37","#9f253d","#971f44","#8e1a4a","#861550",
    "#700e89","#7b1c93","#872b9e","#923aa8","#9e4ab2","#a95bbd","#b56ac7","#c07ad1","#cc8adc","#d79ae6"
];


if (LAPSE_RATE_COLORS.length !== LAPSE_RATE_BOUNDS.length - 1) {
    throw new Error("Lapse-rate palette length does not match bounds.");
}

/* =========================================================================================
   SRH / EHI COLOR TABLES
   Exact user-supplied bins/colors.
   ========================================================================================= */

const SRH_BOUNDS = [0,10,20,30,40,50,60,70,80,90,100,110,120,130,140,150,160,170,180,190,200,210,220,230,240,250,260,270,280,290,300,310,320,330,340,350,360,370,380,390,400,410,420,430,440,450,460,470,480,490,500,510,520,530,540,550,560,570,580,590,600,650,700,750,800,850,900,950,1000,1050];
const SRH_COLORS = ["#ffffff","#f0f0f0","#e1e1e1","#d2d2d2","#c3c3c3","#a5a5a5","#969696","#878787","#787878","#696969","#3b5269","#475f74","#546c7f","#60798a","#6d8695","#7993a1","#86a0ac","#92adb7","#9fbac2","#abc7ce","#e6de99","#e4d289","#e3c679","#e1b96a","#dfae5a","#dfa24b","#dd963c","#dc8a2f","#da7e24","#d9731c","#d3491f","#cb4323","#c23d27","#b9362b","#b13131","#a82b37","#9f253d","#971f44","#8e1a4a","#861550","#700e89","#7b1c93","#872b9e","#923aa8","#9e4ab2","#a95bbd","#b56ac7","#c07ad1","#cc8adc","#d79ae6","#e6bfc3","#dfb1b7","#d9a4ad","#d297a1","#cc8a95","#c57c8a","#be707e","#b86272","#b25667","#ac485b","#844049","#8a4953","#91545c","#985e66","#9e6970","#a57279","#ab7d83","#b2878c","#b99295"];
if (SRH_COLORS.length !== SRH_BOUNDS.length - 1) {
    throw new Error("SRH palette length does not match bounds.");
}

const EHI_BOUNDS = [0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0,1.1,1.2,1.3,1.4,1.5,1.6,1.7,1.8,1.9,2.0,2.2,2.4,2.6,2.8,3.0,3.2,3.4,3.6,3.8,4.0,4.2,4.4,4.6,4.8,5.0,5.2,5.4,5.6,5.8,6.0,6.2,6.4,6.6,6.8,7.0,7.2,7.4,7.6,7.8,8.0,8.4,8.8,9.2,9.6,10.0,10.4,10.8,11.2,11.6,12.0,12.4,12.8,13.2,13.6,14.0,14.4,14.8,15.2,15.6,16.0];
const EHI_COLORS = ["#ffffff","#f0f0f0","#e1e1e1","#d2d2d2","#c3c3c3","#a5a5a5","#969696","#878787","#787878","#696969","#3b5269","#475f74","#546c7f","#60798a","#6d8695","#7993a1","#86a0ac","#92adb7","#9fbac2","#abc7ce","#e6de99","#e4d289","#e3c679","#e1b96a","#dfae5a","#dfa24b","#dd963c","#dc8a2f","#da7e24","#d9731c","#d3491f","#cb4323","#c23d27","#b9362b","#b13131","#a82b37","#9f253d","#971f44","#8e1a4a","#861550","#700e89","#7b1c93","#872b9e","#923aa8","#9e4ab2","#a95bbd","#b56ac7","#c07ad1","#cc8adc","#d79ae6","#e6bfc3","#dfb1b7","#d9a4ad","#d297a1","#cc8a95","#c57c8a","#be707e","#b86272","#b25667","#ac485b","#844049","#8a4953","#91545c","#985e66","#9e6970","#a57279","#ab7d83","#b2878c","#b99295","#b99297"];
if (EHI_COLORS.length !== EHI_BOUNDS.length - 1) {
    throw new Error("EHI palette length does not match bounds.");
}

/* =========================================================================================
   SUPERCELL COMPOSITE PARAMETER COLOR TABLE
   Exact bounds/colors supplied by Matthew. Used by both right- and left-moving SCP.
   ========================================================================================= */

const SCP_BOUNDS = [0, 0.5, 1, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48];

const SCP_COLORS = ["#ffffff","#f0f0f0","#e1e1e1","#d2d2d2","#c3c3c3","#a5a5a5","#969696","#878787","#787878","#696969","#3b5269","#475f74","#546c7f","#60798a","#6d8695","#7993a1","#86a0ac","#92adb7","#9fbac2","#abc7ce","#e6de99","#e4d289","#e3c679","#e1b96a","#dfae5a","#dfa24b","#dd963c","#dc8a2f","#da7e24","#d9731c","#d3491f","#cb4323","#c23d27","#b9362b","#b13131","#a82b37","#9f253d","#971f44","#8e1a4a","#861550","#700e89","#7b1c93","#872b9e","#923aa8","#9e4ab2","#a95bbd","#b56ac7","#c07ad1","#cc8adc","#d79ae6"];


/* =========================================================================================
   SFC TOTAL DEFORMATION COLOR TABLE
   Display units: 10^-5 s^-1. Low deformation is kept light; stronger deformation
   progresses through cyan/blue/purple/red to match the SPC-style diagnostic feel.
   ========================================================================================= */
const SFC_DEFORMATION_BOUNDS = [8,12,16,20,24,28,32];
const SFC_DEFORMATION_COLORS = [
    "#7cff00", "#e6dc00", "#c98900", "#df4b18", "#c20d20", "#8d148f"
];
const SFC_DEFORMATION_RGB = SFC_DEFORMATION_COLORS.map(hexToRgb);

/* =========================================================================================
   FIELD DEFINITIONS
   ========================================================================================= */


/* =========================================================================================
   PRESSURE-LEVEL RELATIVE VORTICITY COLOR TABLE

   Based on Model_4Panel.ipynb: -40 to +50 by 2 x 10^-5 s^-1, with Greys_r
   for negative vorticity, a white near-zero transition, and YlOrRd for
   positive vorticity.
   ========================================================================================= */
const RELATIVE_VORTICITY_BOUNDS = [
    -40,-38,-36,-34,-32,-30,-28,-26,-24,-22,-20,-18,-16,-14,-12,-10,-8,-6,-4,-2,0,
    2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,36,38,40,42,44,46,48,50
];

const RELATIVE_VORTICITY_COLORS = [
    "#000000","#0f0f0f","#1e1e1e","#303030","#434343","#555555","#636363","#717171","#7f7f7f","#8f8f8f",
    "#9e9e9e","#afafaf","#bebebe","#cbcbcb","#d6d6d6","#e1e1e1","#eaeaea","#f3f3f3","#f9f9f9","#ffffff",
    "#ffffff",
    "#ffffcc","#fff9bd","#fff3ae","#ffec9f","#ffe590","#fede82","#fed673","#fec965","#feba55","#fead4a","#fea044",
    "#fd933f","#fd8239","#fc6c33","#fc572c","#f74327","#ed3022","#e51e1d","#d9131f","#cb0a22","#be0126","#aa0026","#950026","#800026"
];

/* Q-vector forcing (-2 div Q, x10^-18): -50 to +50 in 5-unit bins.
 * The -5 to +5 neutral interval is transparent; strongest colors begin at +/-50.
 * This updates the color *display*, not the physically encoded tile values.
 */
const QDIV_BOUNDS = [
    -50,-45,-40,-35,-30,-25,-20,-15,-10,-5,
      5, 10, 15, 20, 25, 30, 35, 40, 45, 50
];
const QDIV_COLORS = [
    "#1500ff", "#3020ff", "#4034ff", "#5a50ff", "#7168ff",
    "#8981ff", "#a39dff", "#bdb8ff", "#d4d1ff",
    "rgba(255,255,255,0)",
    "#ffd0d0", "#ffbaba", "#ffa2a2", "#ff8e8e", "#ff7777",
    "#ff6060", "#ff4444", "#ff2929", "#ff1010"
];
function getQDivColor(value) {
    // The scalar canvas renderer requires an {r, g, b} object, not a CSS string.
    // Missing data and the neutral -5 to +5 interval remain transparent.
    if (!Number.isFinite(value) || (value >= -5 && value < 5)) return null;

    let i = 0;
    while (i < QDIV_BOUNDS.length - 2 && value >= QDIV_BOUNDS[i + 1]) i++;
    const hex = QDIV_COLORS[i];
    if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;

    return {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16)
    };
}

const WEATHER_FIELDS = {
    q_vector_divergence_925mb: { name: "925 mb Q-Vector Div.", shortName: "925 mb Q-Vector Div.", units: "×10⁻¹⁸ m s⁻¹ kg⁻¹", type: "q_vector_divergence" },
    q_vector_divergence_850mb: { name: "850 mb Q-Vector Div.", shortName: "850 mb Q-Vector Div.", units: "×10⁻¹⁸ m s⁻¹ kg⁻¹", type: "q_vector_divergence" },
    q_vector_divergence_700mb: { name: "700 mb Q-Vector Div.", shortName: "700 mb Q-Vector Div.", units: "×10⁻¹⁸ m s⁻¹ kg⁻¹", type: "q_vector_divergence" },
    sbcin: { name: "Surface-Based CIN", shortName: "SBCIN", units: "J/kg", type: "cin" },
    mlcin: { name: "Mixed-Layer CIN", shortName: "MLCIN", units: "J/kg", type: "cin" },
    mucin: { name: "Most-Unstable CIN", shortName: "MUCIN", units: "J/kg", type: "cin" },


    sbcape: {
        name: "Surface-Based CAPE",
        shortName: "SBCAPE",
        units: "J/kg",
        type: "cape"
    },

    mlcape: {
        name: "Mixed-Layer CAPE",
        shortName: "MLCAPE",
        units: "J/kg",
        type: "cape"
    },

    mucape: {
        name: "Most-Unstable CAPE",
        shortName: "MUCAPE",
        units: "J/kg",
        type: "cape"
    },

    mlcape_0_3km: {
        name: "0–3 km Mixed-Layer CAPE",
        shortName: "0–3 km MLCAPE",
        units: "J/kg",
        type: "cape_0_3km"
    },

    wind_speed_925mb: {
        name: "925 mb Wind Speed",
        shortName: "925 mb Wind Speed",
        units: "kt",
        type: "wind_midlevel"
    },

    wind_speed_850mb: {
        name: "850 mb Wind Speed",
        shortName: "850 mb Wind Speed",
        units: "kt",
        type: "wind_midlevel"
    },

    wind_speed_700mb: {
        name: "700 mb Wind Speed",
        shortName: "700 mb Wind Speed",
        units: "kt",
        type: "wind_midlevel"
    },

    wind_speed_500mb: {
        name: "500 mb Wind Speed",
        shortName: "500 mb Wind Speed",
        units: "kt",
        type: "wind_500"
    },

    wind_speed_250mb: {
        name: "250 mb Wind Speed",
        shortName: "250 mb Wind Speed",
        units: "kt",
        type: "wind_250"
    },

    pwat: {
        name: "Precipitable Water",
        shortName: "PWAT",
        units: "in",
        type: "pwat"
    },

    stp_eff: {
        name: "Significant Tornado Parameter (Effective Layer)",
        shortName: "Effective-Layer STP",
        units: "",
        type: "stp"
    },

    stp_fix: {
        name: "Significant Tornado Parameter (Fixed Layer)",
        shortName: "Fixed-Layer STP",
        units: "",
        type: "stp"
    },

    scp_right: {
        name: "Right-Moving Supercell Composite Parameter",
        shortName: "Right-Moving SCP",
        units: "",
        type: "scp"
    },

    scp_left: {
        name: "Left-Moving Supercell Composite Parameter",
        shortName: "Left-Moving SCP",
        units: "",
        type: "scp"
    },

    sfc_temperature: {
        name: "2 m Temperature",
        shortName: "2 m Temperature",
        units: "°F",
        type: "temperature"
    },

    sfc_dewpoint: {
        name: "Surface Dewpoint",
        shortName: "Surface Dewpoint",
        units: "°F",
        type: "dewpoint"
    },

    thetae_2m: {
        name: "2 m Equivalent Potential Temperature",
        shortName: "2 m Theta-e",
        units: "K",
        type: "thetae"
    },

    theta_2m: {
        name: "2 m Potential Temperature",
        shortName: "2 m Theta",
        units: "°F",
        type: "temperature"
    },

    wetbulb_2m: {
        name: "2 m Wet-Bulb Temperature",
        shortName: "2 m Wet-Bulb",
        units: "°F",
        type: "temperature"
    },

    rh_2m: {
        name: "2 m Relative Humidity",
        shortName: "2 m RH",
        units: "%",
        type: "rh"
    },

    petterssen_fgen_surface: { name: "Surface 2D Petterssen Frontogenesis", shortName: "Surface 2D Petterssen Frontogenesis", units: "K/(100 km)/3 h", type: "petterssen_fgen" },
    petterssen_fgen_925mb: { name: "925 mb 2-D Petterssen Frontogenesis", shortName: "925 mb 2-D FGEN", units: "K/(100 km)/3 h", type: "petterssen_fgen" },
    petterssen_fgen_850mb: { name: "850 mb 2-D Petterssen Frontogenesis", shortName: "850 mb 2-D FGEN", units: "K/(100 km)/3 h", type: "petterssen_fgen" },
    petterssen_fgen_700mb: { name: "700 mb 2-D Petterssen Frontogenesis", shortName: "700 mb 2-D FGEN", units: "K/(100 km)/3 h", type: "petterssen_fgen" },

    temperature_925mb: { name: "925 mb Temperature", shortName: "925 mb Temperature", units: "°C", type: "pressure_temperature" },
    temperature_850mb: { name: "850 mb Temperature", shortName: "850 mb Temperature", units: "°C", type: "pressure_temperature" },
    temperature_700mb: { name: "700 mb Temperature", shortName: "700 mb Temperature", units: "°C", type: "pressure_temperature" },
    temperature_500mb: { name: "500 mb Temperature", shortName: "500 mb Temperature", units: "°C", type: "pressure_temperature" },
    temperature_250mb: { name: "250 mb Temperature", shortName: "250 mb Temperature", units: "°C", type: "pressure_temperature" },

    temperature_advection_925mb: { name: "925 mb Temperature Advection", shortName: "925 mb Temp Advection", units: "°C/3 hr", type: "temperature_advection" },
    temperature_advection_850mb: { name: "850 mb Temperature Advection", shortName: "850 mb Temp Advection", units: "°C/3 hr", type: "temperature_advection" },
    temperature_advection_700mb: { name: "700 mb Temperature Advection", shortName: "700 mb Temp Advection", units: "°C/3 hr", type: "temperature_advection" },

    relative_vorticity_925mb: { name: "925 mb Relative Vorticity", shortName: "925 mb Rel Vort", units: "10⁻⁵ s⁻¹", type: "relative_vorticity" },
    relative_vorticity_850mb: { name: "850 mb Relative Vorticity", shortName: "850 mb Rel Vort", units: "10⁻⁵ s⁻¹", type: "relative_vorticity" },
    relative_vorticity_700mb: { name: "700 mb Relative Vorticity", shortName: "700 mb Rel Vort", units: "10⁻⁵ s⁻¹", type: "relative_vorticity" },
    relative_vorticity_500mb: { name: "500 mb Relative Vorticity", shortName: "500 mb Rel Vort", units: "10⁻⁵ s⁻¹", type: "relative_vorticity" },
    relative_vorticity_250mb: { name: "250 mb Relative Vorticity", shortName: "250 mb Rel Vort", units: "10⁻⁵ s⁻¹", type: "relative_vorticity" },

    lapse_rate_700_500hPa: { name: "700–500 mb Lapse Rate", shortName: "700–500 mb Lapse Rate", units: "°C/km", type: "lapse_rate" },
    lapse_rate_0_3km: { name: "0–3 km AGL Lapse Rate", shortName: "0–3 km Lapse Rate", units: "°C/km", type: "lapse_rate" },
    lapse_rate_0_1km: { name: "0–1 km AGL Lapse Rate", shortName: "0–1 km Lapse Rate", units: "°C/km", type: "lapse_rate" },
    lapse_rate_3_6km: { name: "3–6 km AGL Lapse Rate", shortName: "3–6 km Lapse Rate", units: "°C/km", type: "lapse_rate" },
    lapse_rate_2_6km_max: { name: "Maximum 2-km Lapse Rate in 2–6 km AGL", shortName: "2–6 km Max 2-km Lapse Rate", units: "°C/km", type: "lapse_rate" },

    srh_0_500m: { name: "0–500 m Storm-Relative Helicity", shortName: "0–500 m SRH", units: "m²/s²", type: "srh" },
    srh_0_1km: { name: "0–1 km Storm-Relative Helicity", shortName: "0–1 km SRH", units: "m²/s²", type: "srh" },
    srh_0_3km: { name: "0–3 km Storm-Relative Helicity", shortName: "0–3 km SRH", units: "m²/s²", type: "srh" },
    srh_eff: { name: "Effective Storm-Relative Helicity", shortName: "Effective SRH", units: "m²/s²", type: "srh" },
    ehi_0_1km: { name: "0–1 km Energy Helicity Index", shortName: "0–1 km EHI", units: "", type: "ehi" },
    ehi_0_3km: { name: "0–3 km Energy Helicity Index", shortName: "0–3 km EHI", units: "", type: "ehi" },

    rh_925mb: { name: "925 mb Relative Humidity", shortName: "925 mb RH", units: "%", type: "rh" },
    rh_850mb: { name: "850 mb Relative Humidity", shortName: "850 mb RH", units: "%", type: "rh" },
    rh_700mb: { name: "700 mb Relative Humidity", shortName: "700 mb RH", units: "%", type: "rh" },
    rh_500mb: { name: "500 mb Relative Humidity", shortName: "500 mb RH", units: "%", type: "rh" },
    rh_250mb: { name: "250 mb Relative Humidity", shortName: "250 mb RH", units: "%", type: "rh" }

};



const PETTERSSEN_FGEN_BOUNDS = Array.from({length:41},(_,i)=>i-20);
const PETTERSSEN_FGEN_COLORS = Array.from({length:40},(_,i)=>{
    const t=(i+0.5)/40;
    const stops=[[0,[0,0,100]],[0.25,[50,0,255]],[0.5,[255,255,255]],[0.75,[255,55,55]],[1,[125,0,0]]];
    let a=stops[0],b=stops[stops.length-1];
    for(let j=1;j<stops.length;j++){if(t<=stops[j][0]){a=stops[j-1];b=stops[j];break;}}
    const f=(t-a[0])/(b[0]-a[0]);
    return '#'+a[1].map((v,k)=>Math.round(v+(b[1][k]-v)*f).toString(16).padStart(2,'0')).join('');
});
// Neutral band: [-0.5, +0.5] K/(100 km)/3 h is pure white.
// The existing one-unit bins centered at -0.5 and +0.5 are both white.
PETTERSSEN_FGEN_COLORS[19] = "#ffffff";
PETTERSSEN_FGEN_COLORS[20] = "#ffffff";
const PETTERSSEN_FGEN_RGB = PETTERSSEN_FGEN_COLORS.map(c=>[
    parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16)
]);

const VECTOR_FIELDS = {
    q_vector_925mb: { name: "925 mb Q-Vectors", shortName: "925 mb Q-Vectors", defaultColor: "#000000", renderType: "arrows", units: "m² kg⁻¹ s⁻¹" },
    q_vector_850mb: { name: "850 mb Q-Vectors", shortName: "850 mb Q-Vectors", defaultColor: "#000000", renderType: "arrows", units: "m² kg⁻¹ s⁻¹" },
    q_vector_700mb: { name: "700 mb Q-Vectors", shortName: "700 mb Q-Vectors", defaultColor: "#000000", renderType: "arrows", units: "m² kg⁻¹ s⁻¹" },


    sfc_wind: {
        name: "Surface Wind",
        shortName: "Surface Wind",
        defaultColor: "#000000"
    },

    axes_dilatation_925mb: { name: "925 mb Axes of Dilatation", shortName: "925 mb Axes", defaultColor: "#1f5fbf", renderType: "axis_segments", units: "10⁻⁵ s⁻¹" },
    axes_dilatation_850mb: { name: "850 mb Axes of Dilatation", shortName: "850 mb Axes", defaultColor: "#1f5fbf", renderType: "axis_segments", units: "10⁻⁵ s⁻¹" },
    axes_dilatation_700mb: { name: "700 mb Axes of Dilatation", shortName: "700 mb Axes", defaultColor: "#1f5fbf", renderType: "axis_segments", units: "10⁻⁵ s⁻¹" },
    sfc_axes_dilatation: {
        name: "SFC Axes of Dilatation",
        shortName: "SFC Axes of Dilatation",
        defaultColor: "#1f5fbf",
        renderType: "axis_segments",
        units: "10⁻⁵ s⁻¹"
    },

    srwind_0_2km: {
        name: "0–2 km Storm-Relative Wind",
        shortName: "0–2 km SR Wind",
        defaultColor: "#000000"
    },

    srwind_4_6km: {
        name: "4–6 km Storm-Relative Wind",
        shortName: "4–6 km SR Wind",
        defaultColor: "#000000"
    },

    srwind_9_11km: {
        name: "9–11 km Storm-Relative Wind",
        shortName: "9–11 km SR Wind",
        defaultColor: "#000000"
    },

    srwind_effective: {
        name: "Effective Storm-Relative Wind",
        shortName: "Effective SR Wind",
        defaultColor: "#000000"
    },

    srwind_anvil: {
        name: "Anvil-Level Storm-Relative Wind",
        shortName: "Anvil-Level SR Wind",
        defaultColor: "#000000"
    },

    shear_0_1km: {
        name: "0–1 km Bulk Shear",
        shortName: "0–1 km Bulk Shear",
        defaultColor: "#000000"
    },

    shear_0_3km: {
        name: "0–3 km Bulk Shear",
        shortName: "0–3 km Bulk Shear",
        defaultColor: "#000000"
    },

    shear_0_6km: {
        name: "0–6 km Bulk Shear",
        shortName: "0–6 km Bulk Shear",
        defaultColor: "#000000"
    },

    shear_0_8km: {
        name: "0–8 km Bulk Shear",
        shortName: "0–8 km Bulk Shear",
        defaultColor: "#000000"
    },

    effective_shear: {
        name: "Effective Bulk Shear",
        shortName: "Effective Bulk Shear",
        defaultColor: "#000000"
    },

    bunkers_right: {
        name: "Bunkers Right-Mover Storm Motion",
        shortName: "Bunkers Right",
        defaultColor: "#000000"
    },

    bunkers_left: {
        name: "Bunkers Left-Mover Storm Motion",
        shortName: "Bunkers Left",
        defaultColor: "#000000"
    },

    mean_wind_0_6km: {
        name: "0–6 km Mean Wind",
        shortName: "0–6 km Mean Wind",
        defaultColor: "#000000"
    },

    mean_wind_mu_lcl_el: {
        name: "MU LCL–EL Mean Wind",
        shortName: "MU LCL–EL Mean Wind",
        defaultColor: "#000000"
    },

    wind_925mb: {
        name: "925 mb Wind",
        shortName: "925 mb Wind",
        defaultColor: "#000000"
    },

    wind_850mb: {
        name: "850 mb Wind",
        shortName: "850 mb Wind",
        defaultColor: "#000000"
    },

    wind_700mb: {
        name: "700 mb Wind",
        shortName: "700 mb Wind",
        defaultColor: "#000000"
    },

    wind_500mb: {
        name: "500 mb Wind",
        shortName: "500 mb Wind",
        defaultColor: "#000000"
    },

    wind_250mb: {
        name: "250 mb Wind",
        shortName: "250 mb Wind",
        defaultColor: "#000000"
    }

};

const VECTOR_OVERLAY_CONFIG = [
    { field: "q_vector_925mb", stateKey: "qVector925", toggleId: "q-vector-925mb-toggle" },
    { field: "q_vector_850mb", stateKey: "qVector850", toggleId: "q-vector-850mb-toggle" },
    { field: "q_vector_700mb", stateKey: "qVector700", toggleId: "q-vector-700mb-toggle" },

    { field: "sfc_wind", stateKey: "surfaceWind", toggleId: "sfc-wind-toggle" },
    { field: "sfc_axes_dilatation", stateKey: "sfcAxesDilatation", toggleId: "sfc-axes-dilatation-toggle" },
    { field: "axes_dilatation_925mb", stateKey: "axesDilatation925", toggleId: "axes-dilatation-925mb-toggle" },
    { field: "axes_dilatation_850mb", stateKey: "axesDilatation850", toggleId: "axes-dilatation-850mb-toggle" },
    { field: "axes_dilatation_700mb", stateKey: "axesDilatation700", toggleId: "axes-dilatation-700mb-toggle" },

    { field: "srwind_0_2km", stateKey: "srWind02", toggleId: "srwind-02-toggle" },
    { field: "srwind_4_6km", stateKey: "srWind46", toggleId: "srwind-46-toggle" },
    { field: "srwind_9_11km", stateKey: "srWind911", toggleId: "srwind-911-toggle" },
    { field: "srwind_effective", stateKey: "srWindEffective", toggleId: "srwind-effective-toggle" },
    { field: "srwind_anvil", stateKey: "srWindAnvil", toggleId: "srwind-anvil-toggle" },
    { field: "shear_0_1km", stateKey: "shear01", toggleId: "shear-01-toggle" },
    { field: "shear_0_3km", stateKey: "shear03", toggleId: "shear-03-toggle" },
    { field: "shear_0_6km", stateKey: "shear06", toggleId: "shear-06-toggle" },
    { field: "shear_0_8km", stateKey: "shear08", toggleId: "shear-08-toggle" },
    { field: "effective_shear", stateKey: "effectiveShear", toggleId: "effective-shear-toggle" },
    { field: "bunkers_right", stateKey: "bunkersRight", toggleId: "bunkers-right-toggle" },
    { field: "bunkers_left", stateKey: "bunkersLeft", toggleId: "bunkers-left-toggle" },
    { field: "mean_wind_0_6km", stateKey: "meanWind06", toggleId: "mean-wind-06-toggle" },
    { field: "mean_wind_mu_lcl_el", stateKey: "meanWindMuLclEl", toggleId: "mean-wind-mu-lcl-el-toggle" },
    { field: "wind_925mb", stateKey: "wind925", toggleId: "wind-925mb-toggle" },
    { field: "wind_850mb", stateKey: "wind850", toggleId: "wind-850mb-toggle" },
    { field: "wind_700mb", stateKey: "wind700", toggleId: "wind-700mb-toggle" },
    { field: "wind_500mb", stateKey: "wind500", toggleId: "wind-500mb-toggle" },
    { field: "wind_250mb", stateKey: "wind250", toggleId: "wind-250mb-toggle" }
];

const vectorColors = Object.fromEntries(
    Object.entries(VECTOR_FIELDS).map(
        ([field, definition]) => [field, definition.defaultColor || "#000000"]
    )
);


/* =========================================================================================
   CONTOUR DEFINITIONS
   ========================================================================================= */

const CONTOUR_FIELDS = {
    sbcin_contours: { name: "Surface-Based CIN Contours", shortName: "SBCIN Contours", units: "J/kg", interval: 25, minimum: -1000, maximum: -25, anchor: -1000, colorScheme: "blues", smoothGeometry: false, smoothIterations: 4 },
    mlcin_contours: { name: "Mixed-Layer CIN Contours", shortName: "MLCIN Contours", units: "J/kg", interval: 25, minimum: -1000, maximum: -25, anchor: -1000, colorScheme: "blues", smoothGeometry: false, smoothIterations: 4 },
    mucin_contours: { name: "Most-Unstable CIN Contours", shortName: "MUCIN Contours", units: "J/kg", interval: 25, minimum: -1000, maximum: -25, anchor: -1000, colorScheme: "blues", smoothGeometry: false, smoothIterations: 4 },


    dcp_contours: {
        name: "Derecho Composite Parameter", shortName: "DCP", units: "",
        levels: [1, 2, 4, 6, 8, 10, 12], colorScheme: "dcp_spc"
    },
    lhp_contours: {
        name: "Large Hail Parameter", shortName: "LHP", units: "",
        levels: [4, 6, 8, 12, 16, 20], colorScheme: "lhp_spc"
    },
    shp_contours: {
        name: "Significant Hail Parameter", shortName: "SHIP", units: "",
        levels: [0.5, 1, 1.5, 2, 3, 5], colorScheme: "shp_spc"
    },


    theta_2m_contours: { name: "2 m Potential Temperature", shortName: "2 m Theta", units: "K", interval: 2, minimum: null, colorScheme: "theta", color: "#d7191c", smoothGeometry: true, smoothIterations: 4 },
    thetae_2m_contours: { name: "2 m Equivalent Potential Temperature", shortName: "2 m Theta-e", units: "K", interval: 2, minimum: 310, anchor: 310, colorScheme: "thetae", color: null, smoothGeometry: true, smoothIterations: 4 },

    lcl_height: {
        name: "LCL Height",
        shortName: "LCL Height",
        units: "m AGL",
        interval: 250,
        minimum: 250,
        maximum: 4000,
        colorScheme: "lcl",
        color: null
    },

    sfc_mslp: {
        name: "Surface MSLP",
        shortName: "MSLP",
        units: "hPa",
        interval: 2,
        minimum: null,
        colorScheme: "fixed",
        color: "#000000",
        smoothGeometry: true,
        smoothIterations: 4
    },

    dcape: {
        name: "Downdraft CAPE",
        shortName: "DCAPE",
        units: "J/kg",
        interval: 200,
        minimum: 100,
        colorScheme: "dcape",
        color: null
    },

    warm_cloud_depth: {
        name: "Warm Cloud Depth",
        shortName: "Warm Cloud Depth",
        units: "m",
        interval: 250,
        minimum: 250,
        colorScheme: "wcd",
        color: null
    },

    hght_925mb: {
        name: "925 mb Geopotential Height",
        shortName: "925 mb Height",
        units: "m",
        interval: 30,
        minimum: null,
        colorScheme: "fixed",
        color: "#000000",
        smoothGeometry: true,
        smoothIterations: 4
    },

    hght_850mb: {
        name: "850 mb Geopotential Height",
        shortName: "850 mb Height",
        units: "m",
        interval: 30,
        minimum: null,
        colorScheme: "fixed",
        color: "#000000",
        smoothGeometry: true,
        smoothIterations: 4
    },

    hght_700mb: {
        name: "700 mb Geopotential Height",
        shortName: "700 mb Height",
        units: "m",
        interval: 30,
        minimum: null,
        colorScheme: "fixed",
        color: "#000000",
        smoothGeometry: true,
        smoothIterations: 4
    },

    hght_500mb: {
        name: "500 mb Geopotential Height",
        shortName: "500 mb Height",
        units: "m",
        interval: 30,
        minimum: null,
        colorScheme: "fixed",
        color: "#000000",
        smoothGeometry: true,
        smoothIterations: 4
    },

    hght_250mb: {
        name: "250 mb Geopotential Height",
        shortName: "250 mb Height",
        units: "m",
        interval: 60,
        minimum: null,
        colorScheme: "fixed",
        color: "#000000",
        smoothGeometry: true,
        smoothIterations: 4
    },

    temperature_contours_925mb: { name: "925 mb Temperature Isotherms", shortName: "925 mb Isotherms", units: "°C", levels: Array.from({length:61},(_,i)=>(i-40)*2), interval: 2, minimum: -80, maximum: 40, colorScheme: "pressure_temperature_isotherms", color: null, smoothGeometry: true, smoothIterations: 4 },
    temperature_contours_850mb: { name: "850 mb Temperature Isotherms", shortName: "850 mb Isotherms", units: "°C", levels: Array.from({length:61},(_,i)=>(i-40)*2), interval: 2, minimum: -80, maximum: 40, colorScheme: "pressure_temperature_isotherms", color: null, smoothGeometry: true, smoothIterations: 4 },
    temperature_contours_700mb: { name: "700 mb Temperature Isotherms", shortName: "700 mb Isotherms", units: "°C", levels: Array.from({length:61},(_,i)=>(i-40)*2), interval: 2, minimum: -80, maximum: 40, colorScheme: "pressure_temperature_isotherms", color: null, smoothGeometry: true, smoothIterations: 4 },
    temperature_contours_500mb: { name: "500 mb Temperature Isotherms", shortName: "500 mb Isotherms", units: "°C", levels: Array.from({length:61},(_,i)=>(i-40)*2), interval: 2, minimum: -80, maximum: 40, colorScheme: "pressure_temperature_isotherms", color: null, smoothGeometry: true, smoothIterations: 4 },
    temperature_contours_250mb: { name: "250 mb Temperature Isotherms", shortName: "250 mb Isotherms", units: "°C", levels: Array.from({length:61},(_,i)=>(i-40)*2), interval: 2, minimum: -80, maximum: 40, colorScheme: "pressure_temperature_isotherms", color: null, smoothGeometry: true, smoothIterations: 4 },

    frontogenesis_925mb: { name: "925 mb Frontogenesis", shortName: "925 mb Frontogenesis", units: "K/(100 km)/3 hr", interval: 1, minimum: 1, maximum: 49, colorScheme: "fixed", color: "#990099", smoothGeometry: true, smoothIterations: 4 },
    frontogenesis_850mb: { name: "850 mb Frontogenesis", shortName: "850 mb Frontogenesis", units: "K/(100 km)/3 hr", interval: 1, minimum: 1, maximum: 49, colorScheme: "fixed", color: "#990099", smoothGeometry: true, smoothIterations: 4 },
    frontogenesis_700mb: { name: "700 mb Frontogenesis", shortName: "700 mb Frontogenesis", units: "K/(100 km)/3 hr", interval: 1, minimum: 1, maximum: 49, colorScheme: "fixed", color: "#990099", smoothGeometry: true, smoothIterations: 4 },

    divergence_925mb: {
        name: "925 mb Divergence",
        shortName: "925 mb Divergence",
        units: "10^-5 s^-1",
        interval: 2,
        minimum: 2,
        maximum: null,
        colorScheme: "fixed",
        color: "#ff00ff",
        smoothGeometry: true,
        smoothIterations: 4
    },

    divergence_850mb: {
        name: "850 mb Divergence",
        shortName: "850 mb Divergence",
        units: "10^-5 s^-1",
        interval: 2,
        minimum: 2,
        maximum: null,
        colorScheme: "fixed",
        color: "#ff00ff",
        smoothGeometry: true,
        smoothIterations: 4
    },

    divergence_700mb: {
        name: "700 mb Divergence",
        shortName: "700 mb Divergence",
        units: "10^-5 s^-1",
        interval: 2,
        minimum: 2,
        maximum: null,
        colorScheme: "fixed",
        color: "#ff00ff",
        smoothGeometry: true,
        smoothIterations: 4
    },

    divergence_500mb: {
        name: "500 mb Divergence",
        shortName: "500 mb Divergence",
        units: "10^-5 s^-1",
        interval: 2,
        minimum: 2,
        maximum: null,
        colorScheme: "fixed",
        color: "#ff00ff",
        smoothGeometry: true,
        smoothIterations: 4
    },

    divergence_250mb: {
        name: "250 mb Divergence",
        shortName: "250 mb Divergence",
        units: "10^-5 s^-1",
        interval: 2,
        minimum: 2,
        maximum: null,
        colorScheme: "fixed",
        color: "#ff00ff",
        smoothGeometry: true,
        smoothIterations: 4
    },

    frontogenesis_850mb: {
        name: "850 mb Frontogenesis",
        shortName: "850 mb Frontogenesis",
        units: "K / (100 km) / 3 h",
        interval: 1,
        minimum: 1,
        maximum: null,
        colorScheme: "fixed",
        color: "#990099",
        smoothGeometry: true,
        smoothIterations: 4
    },

    frontogenesis_700mb: {
        name: "700 mb Frontogenesis",
        shortName: "700 mb Frontogenesis",
        units: "K / (100 km) / 3 h",
        interval: 1,
        minimum: 1,
        maximum: null,
        colorScheme: "fixed",
        color: "#990099",
        smoothGeometry: true,
        smoothIterations: 4
    }

};


/* =========================================================================================
   STATE
   ========================================================================================= */

let currentRun = null;

let currentAnalysisTime = null;

/* =========================================================================================
   TIMELINE / ANIMATION STATE
   ========================================================================================= */

const timelineState = {
    availableRuns: [],
    historyHours: 12,
    currentIndex: -1,
    latestRun: null,
    playing: false,
    looping: true,
    playbackSpeed: 1.0,
    isLive: true,
    pendingLiveSwitch: false,
    switching: false,
    playTimer: null
};

const runMetadataCache = new Map();
const runProductMetadataCache = new Map();
const adjacentPreloadControllers = new Map();

const PLAYBACK_BASE_MS = 700;
const LIVE_MANIFEST_REFRESH_MS = 180000;

let runMetadata = null;

let activeField = "none";

const activeOverlays = {
    sbcinContours: false,
    mlcinContours: false,
    mucinContours: false,
    surfaceWind: false,
    sfcAxesDilatation: false,
    srWind02: false,
    srWind46: false,
    srWind911: false,
    srWindEffective: false,
    srWindAnvil: false,
    shear01: false,
    shear03: false,
    shear06: false,
    shear08: false,
    effectiveShear: false,
    bunkersRight: false,
    bunkersLeft: false,
    meanWind06: false,
    meanWindMuLclEl: false,
    wind925: false,
    wind850: false,
    wind700: false,
    wind500: false,
    wind250: false,
    mslp: false,
    dcape: false,
    warmCloudDepth: false,
    hght925: false,
    hght850: false,
    hght700: false,
    hght500: false,
    hght250: false,
    tempContour925: false,
    tempContour850: false,
    tempContour700: false,
    tempContour500: false,
    tempContour250: false,
    frontogenesis925: false,
    frontogenesis850: false,
    frontogenesis700: false,
    lclHeight: false,
    stpEff: false,
    dcpContours: false,
    lhpContours: false,
    shpContours: false,
    thetaContours: false,
    thetaeContours: false,
    divergence925: false,
    divergence850: false,
    divergence700: false,
    divergence500: false,
    divergence250: false
};

let fieldMetadata = {};

let vectorMetadata = {};

let contourMetadata = {};

let citiesEnabled = false;

// County outlines are visible by default and can be toggled under Map Layers.
let countiesEnabled = true;

let cwaBordersEnabled = true;

let cwaBorderColor = "#6f42c1";

let cwaBorderWidth = 2.0;

let selectedCwa = "ALL";


/* =========================================================================================
   CACHES
   ========================================================================================= */

const scalarTileCache = new Map();

const vectorTileCache = new Map();

const contourTileCache = new Map();

/* Memory bound applies to decoded tile arrays only (not browser HTTP cache).
   A single 256x256 scalar tile is 128 KiB; vector tiles are 256 KiB.
   Map insertion order is our LRU; touches happen when a tile is requested,
   not for every numerical sample during a canvas redraw. */
const MAX_NUMERICAL_CACHE_BYTES = 192 * 1024 * 1024;
const numericalTileLRU = new Map();
const missingNumericalTiles = new Map();
let numericalCacheBytes = 0;

function dropNumericalTileRecord(kind, key) {
    const id = kind + ":" + key;
    const record = numericalTileLRU.get(id);
    if (record) {
        numericalCacheBytes -= record.bytes;
        numericalTileLRU.delete(id);
    }
}

function touchNumericalTile(kind, key) {
    const id = kind + ":" + key;
    const record = numericalTileLRU.get(id);
    if (!record) return;
    numericalTileLRU.delete(id);
    numericalTileLRU.set(id, record);
}

function rememberNumericalTile(kind, cache, key, tile) {
    if (!tile || !tile.byteLength) return;
    dropNumericalTileRecord(kind, key);
    numericalTileLRU.set(kind + ":" + key, {
        cache, key, tile, bytes: tile.byteLength
    });
    numericalCacheBytes += tile.byteLength;
    // Never evict unfinished Promise entries, and never delete a replacement
    // value if an earlier asynchronous request finished out of order.
    while (numericalCacheBytes > MAX_NUMERICAL_CACHE_BYTES && numericalTileLRU.size) {
        const [oldId, oldest] = numericalTileLRU.entries().next().value;
        numericalTileLRU.delete(oldId);
        numericalCacheBytes -= oldest.bytes;
        if (oldest.cache.get(oldest.key) === oldest.tile) {
            oldest.cache.delete(oldest.key);
        }
    }
}

function resetNumericalTileCaches() {
    scalarTileCache.clear();
    vectorTileCache.clear();
    contourTileCache.clear();
    numericalTileLRU.clear();
    missingNumericalTiles.clear();
    numericalCacheBytes = 0;
}

/* One request pool per viewer panel prevents large Promise.all batches from
   overwhelming the network. Visible-center tiles take precedence over the
   one-tile margin, cursor sampling, and historical animation warmups. */
const MAX_ACTIVE_TILE_REQUESTS = 10;
const numericalRequestQueue = [];
let activeTileRequests = 0;
let requestSequence = 0;

function queueNumericalTileFetch(url, priority = 0) {
    return new Promise(resolve => {
        numericalRequestQueue.push({url, priority, sequence: requestSequence++, resolve});
        numericalRequestQueue.sort((a, b) =>
            a.priority - b.priority || a.sequence - b.sequence);
        pumpNumericalTileRequests();
    });
}

function pumpNumericalTileRequests() {
    while (activeTileRequests < MAX_ACTIVE_TILE_REQUESTS && numericalRequestQueue.length) {
        const job = numericalRequestQueue.shift();
        activeTileRequests++;
        (async () => {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const response = await fetch(job.url, {cache: "force-cache"});
                    if (response.ok) return await response.arrayBuffer();
                    // 404 usually means no data exists for that geographic tile.
                    if (response.status !== 429 && response.status < 500) return null;
                } catch (error) {
                    if (attempt === 2) console.warn("Tile request failed:", job.url, error);
                }
                if (attempt < 2) {
                    await new Promise(resolve => setTimeout(resolve,
                        (attempt + 1) * 350 + Math.round(Math.random() * 120)));
                }
            }
            return null;
        })().then(job.resolve, error => {
            console.warn("Tile fetch failed:", job.url, error);
            job.resolve(null);
        }).finally(() => {
            activeTileRequests--;
            pumpNumericalTileRequests();
        });
    }
}

function canRetryMissingTile(kind, key) {
    const id = kind + ":" + key;
    const retryTime = missingNumericalTiles.get(id);
    if (!retryTime) return true;
    if (Date.now() >= retryTime) {
        missingNumericalTiles.delete(id);
        return true;
    }
    return false;
}

function markMissingTile(kind, key) {
    // Temporary outage or missing coverage: retry on a later view/run refresh.
    missingNumericalTiles.set(kind + ":" + key, Date.now() + 30000);
    if (missingNumericalTiles.size > 4096) {
        missingNumericalTiles.delete(missingNumericalTiles.keys().next().value);
    }
}

function priorityOrderedTileCoordinates(z, range) {
    const visible = getVisibleTileRange(z, 0);
    const cx = (visible.x0 + visible.x1) * 0.5;
    const cy = (visible.y0 + visible.y1) * 0.5;
    const result = [];
    for (let x = range.x0; x <= range.x1; x++) {
        for (let y = range.y0; y <= range.y1; y++) {
            const onScreen = x >= visible.x0 && x <= visible.x1 &&
                y >= visible.y0 && y <= visible.y1;
            result.push({x, y, onScreen, distance: (x-cx)**2 + (y-cy)**2});
        }
    }
    return result.sort((a,b) => Number(b.onScreen) - Number(a.onScreen) || a.distance - b.distance);
}


/* =========================================================================================
   GENERATION COUNTERS
   ========================================================================================= */

let scalarRenderGeneration = 0;

let vectorRenderGeneration = 0;

let contourRenderGeneration = 0;

let cursorGeneration = 0;


/* =========================================================================================
   CAMERA TRACKING
   ========================================================================================= */

let capturedCamera = null;

let moveEndTimer = null;


/* =========================================================================================
   DOM
   ========================================================================================= */

const mapContainer =
    document.getElementById("map");

const mapWrapper =
    document.getElementById("map-wrapper");

const timelineBar = document.getElementById("timeline-bar");
const timelinePlayButton = document.getElementById("timeline-play");
const timelinePrevButton = document.getElementById("timeline-prev");
const timelineNextButton = document.getElementById("timeline-next");
const timelineSpeedDownButton = document.getElementById("timeline-speed-down");
const timelineSpeedUpButton = document.getElementById("timeline-speed-up");
const timelineSpeedLabel = document.getElementById("timeline-speed-label");
const timelineTimeLabel = document.getElementById("timeline-time-label");
const timelineSlider = document.getElementById("timeline-slider");
const timelineLoopToggle = document.getElementById("timeline-loop");
const timelineLiveButton = document.getElementById("timeline-live");
const timelineHistorySelect = document.getElementById("timeline-history");

const weatherCanvas =
    document.getElementById("weather-canvas");

const vectorCanvas =
    document.getElementById("vector-canvas");

let contourCanvas =
    document.getElementById("contour-canvas");

const geographyCanvas =
    document.getElementById("geography-canvas");


/* =========================================================================================
   CONTOUR CANVAS
   ========================================================================================= */

/*
 * contour-canvas should normally already exist in index.html.
 *
 * This fallback keeps app.js compatible if it does not.
 */

if (!contourCanvas) {

    contourCanvas =
        document.createElement("canvas");

    contourCanvas.id =
        "contour-canvas";

    contourCanvas.style.position =
        "absolute";

    contourCanvas.style.inset =
        "0";

    contourCanvas.style.width =
        "100%";

    contourCanvas.style.height =
        "100%";

    contourCanvas.style.pointerEvents =
        "none";

    mapWrapper.appendChild(
        contourCanvas
    );

}


/* =========================================================================================
   MSLP LABEL CANVAS
   ========================================================================================= */

/*
 * IMPORTANT:
 *
 * MSLP contour lines remain on contourCanvas.
 *
 * MSLP contour labels are drawn on this separate canvas so the labels
 * can sit ABOVE states, counties, cities, wind barbs, and filled fields.
 */

let contourLabelCanvas =
    document.getElementById(
        "contour-label-canvas"
    );

if (!contourLabelCanvas) {

    contourLabelCanvas =
        document.createElement(
            "canvas"
        );

    contourLabelCanvas.id =
        "contour-label-canvas";

    contourLabelCanvas.style.position =
        "absolute";

    contourLabelCanvas.style.inset =
        "0";

    contourLabelCanvas.style.width =
        "100%";

    contourLabelCanvas.style.height =
        "100%";

    contourLabelCanvas.style.pointerEvents =
        "none";

    contourLabelCanvas.setAttribute(
        "aria-hidden",
        "true"
    );

    mapWrapper.appendChild(
        contourLabelCanvas
    );

}


/* =========================================================================================
   CANVAS STACK
   ========================================================================================= */

/*
 * Bottom → top:
 *
 * MapLibre
 * weather shading
 * contour lines
 * counties / states / cities
 * contour labels
 * wind barbs
 *
 * Wind barbs intentionally render above every other custom canvas.
 */

weatherCanvas.style.zIndex =
    "2";

vectorCanvas.style.zIndex =
    "7";

contourCanvas.style.zIndex =
    "4";

geographyCanvas.style.zIndex =
    "5";

contourLabelCanvas.style.zIndex =
    "6";


/* =========================================================================================
   CONTEXTS
   ========================================================================================= */

const weatherCtx =
    weatherCanvas.getContext("2d");

const vectorCtx =
    vectorCanvas.getContext("2d");

const contourCtx =
    contourCanvas.getContext("2d");

const geographyCtx =
    geographyCanvas.getContext("2d");

const contourLabelCtx =
    contourLabelCanvas.getContext("2d");


/* =========================================================================================
   CONTROLS
   ========================================================================================= */

const fieldSelect =
    document.getElementById("field-select");


/*
 * Add the pressure-level filled wind-speed fields dynamically so index.html
 * does not need to change. Existing options are preserved exactly.
 */
function ensureFilledWindFieldOptions() {

    if (!fieldSelect) {
        return;
    }

    const fields = [
        "q_vector_divergence_925mb",
        "q_vector_divergence_850mb",
        "q_vector_divergence_700mb",
        "wind_speed_925mb",
        "wind_speed_850mb",
        "wind_speed_700mb",
        "wind_speed_500mb",
        "wind_speed_250mb",
        "pwat",
        "stp_eff",
        "stp_fix",
        "sfc_temperature",
        "theta_2m",
        "wetbulb_2m",
        "thetae_2m",
        "rh_2m",
        "relative_vorticity_925mb",
        "relative_vorticity_850mb",
        "relative_vorticity_700mb",
        "relative_vorticity_500mb",
        "relative_vorticity_250mb",
        "temperature_925mb",
        "temperature_850mb",
        "temperature_700mb",
        "temperature_500mb",
        "temperature_250mb",
        "rh_925mb",
        "rh_850mb",
        "rh_700mb",
        "rh_500mb",
        "rh_250mb"
    ];

    for (const field of fields) {

        if (
            fieldSelect.querySelector(
                `option[value="${field}"]`
            )
        ) {
            continue;
        }

        const option =
            document.createElement("option");

        option.value = field;
        option.textContent = WEATHER_FIELDS[field].name;
        fieldSelect.appendChild(option);
    }
}

ensureFilledWindFieldOptions();

const sectorSelect =
    document.getElementById("sector-select");

const citiesToggle =
    document.getElementById("cities-toggle");

/*
 * Counties are injected into the existing Map Layers card so index.html
 * does not need to change. Counties remain ON by default.
 */
let countiesToggle =
    document.getElementById("counties-toggle");

function ensureCountiesControl() {

    if (countiesToggle) {
        countiesToggle.checked = countiesEnabled;
        return;
    }

    const citiesRow =
        citiesToggle
            ? citiesToggle.closest("label")
            : null;

    if (!citiesRow || !citiesRow.parentElement) {
        return;
    }

    const countyRow = document.createElement("label");
    countyRow.className = "toggle-row";
    countyRow.style.display = "flex";
    countyRow.style.alignItems = "center";
    countyRow.style.gap = "6px";

    countiesToggle = document.createElement("input");
    countiesToggle.type = "checkbox";
    countiesToggle.id = "counties-toggle";
    countiesToggle.checked = true;

    const text = document.createElement("span");
    text.textContent = "Counties";

    countyRow.appendChild(countiesToggle);
    countyRow.appendChild(text);

    // Put Counties immediately above Cities in Map Layers.
    citiesRow.insertAdjacentElement("beforebegin", countyRow);
}

ensureCountiesControl();

/*
 * CWA borders are injected into the existing Map Layers card so index.html
 * does not need to change. Controls include on/off, office selector, color,
 * and line thickness. All controls redraw geography immediately and are
 * honored by PNG/GIF exports because those exports composite geographyCanvas.
 */
let cwaBordersToggle =
    document.getElementById("cwa-borders-toggle");

let cwaSelector =
    document.getElementById("cwa-selector");

let cwaBorderColorInput =
    document.getElementById("cwa-border-color");

let cwaBorderWidthSelect =
    document.getElementById("cwa-border-width");

function ensureCwaBorderControls() {

    if (
        cwaBordersToggle &&
        cwaSelector &&
        cwaBorderColorInput &&
        cwaBorderWidthSelect
    ) {
        return;
    }

    const citiesRow =
        citiesToggle
            ? citiesToggle.closest("label")
            : null;

    const mapLayersContainer =
        citiesRow
            ? citiesRow.parentElement
            : null;

    if (!mapLayersContainer) {
        return;
    }

    const wrapper = document.createElement("div");
    wrapper.id = "cwa-controls-wrapper";
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.gap = "6px";
    wrapper.style.marginTop = "2px";

    const topRow = document.createElement("label");
    topRow.className = "toggle-row";
    topRow.style.display = "flex";
    topRow.style.alignItems = "center";
    topRow.style.gap = "6px";

    cwaBordersToggle = document.createElement("input");
    cwaBordersToggle.type = "checkbox";
    cwaBordersToggle.id = "cwa-borders-toggle";
    cwaBordersToggle.checked = true;

    const text = document.createElement("span");
    text.textContent = "CWA Borders";

    cwaBorderColorInput = document.createElement("input");
    cwaBorderColorInput.type = "color";
    cwaBorderColorInput.id = "cwa-border-color";
    cwaBorderColorInput.value = cwaBorderColor;
    cwaBorderColorInput.title = "CWA border color";
    cwaBorderColorInput.setAttribute("aria-label", "CWA border color");
    cwaBorderColorInput.style.width = "28px";
    cwaBorderColorInput.style.height = "22px";
    cwaBorderColorInput.style.padding = "0";
    cwaBorderColorInput.style.border = "none";
    cwaBorderColorInput.style.background = "transparent";
    cwaBorderColorInput.style.cursor = "pointer";
    cwaBorderColorInput.style.marginLeft = "auto";

    topRow.appendChild(cwaBordersToggle);
    topRow.appendChild(text);
    topRow.appendChild(cwaBorderColorInput);

    const optionsRow = document.createElement("div");
    optionsRow.style.display = "grid";
    optionsRow.style.gridTemplateColumns = "minmax(0, 1fr) 76px";
    optionsRow.style.gap = "6px";
    optionsRow.style.paddingLeft = "22px";

    cwaSelector = document.createElement("select");
    cwaSelector.id = "cwa-selector";
    cwaSelector.title = "CWA to display";
    cwaSelector.setAttribute("aria-label", "CWA to display");
    cwaSelector.style.minWidth = "0";
    cwaSelector.style.width = "100%";
    cwaSelector.style.fontSize = "11px";

    const allOption = document.createElement("option");
    allOption.value = "ALL";
    allOption.textContent = "All CWAs";
    cwaSelector.appendChild(allOption);

    cwaBorderWidthSelect = document.createElement("select");
    cwaBorderWidthSelect.id = "cwa-border-width";
    cwaBorderWidthSelect.title = "CWA border thickness";
    cwaBorderWidthSelect.setAttribute("aria-label", "CWA border thickness");
    cwaBorderWidthSelect.style.width = "76px";
    cwaBorderWidthSelect.style.fontSize = "11px";

    for (const width of [1, 1.5, 2, 2.5, 3, 4, 5]) {
        const option = document.createElement("option");
        option.value = String(width);
        option.textContent = `${width}px`;
        if (width === cwaBorderWidth) {
            option.selected = true;
        }
        cwaBorderWidthSelect.appendChild(option);
    }

    optionsRow.appendChild(cwaSelector);
    optionsRow.appendChild(cwaBorderWidthSelect);

    wrapper.appendChild(topRow);
    wrapper.appendChild(optionsRow);

    citiesRow.insertAdjacentElement("afterend", wrapper);
}

function populateCwaSelector() {

    if (!cwaSelector) {
        return;
    }

    const previousValue = selectedCwa || "ALL";

    while (cwaSelector.options.length > 1) {
        cwaSelector.remove(1);
    }

    const offices = cwaFeatures
        .map(feature => {
            const properties = feature.properties || {};
            const code = String(
                properties.CWA || properties.WFO || ""
            ).trim().toUpperCase();
            const cityState = String(
                properties.CITYSTATE || ""
            ).trim();
            return { code, cityState };
        })
        .filter(item => item.code);

    const uniqueOffices = Array.from(
        new Map(
            offices.map(item => [item.code, item])
        ).values()
    ).sort((a, b) => a.code.localeCompare(b.code));

    for (const office of uniqueOffices) {
        const option = document.createElement("option");
        option.value = office.code;
        option.textContent = office.cityState
            ? `${office.code} — ${office.cityState}`
            : office.code;
        cwaSelector.appendChild(option);
    }

    const hasPrevious = Array.from(cwaSelector.options)
        .some(option => option.value === previousValue);

    selectedCwa = hasPrevious ? previousValue : "ALL";
    cwaSelector.value = selectedCwa;
}

ensureCwaBorderControls();

const surfaceWindToggle =
    document.getElementById("sfc-wind-toggle");

const srWind46Toggle =
    document.getElementById("srwind-46-toggle");

/*
 * Wind controls are completed dynamically so the existing index.html can
 * remain unchanged. Every wind layer defaults to black, and each layer gets
 * its own browser color picker.
 */
const vectorToggleElements = {};
const vectorColorElements = {};

function ensureVectorControls() {

    const existingAnchor =
        srWind46Toggle
            ? srWind46Toggle.closest("label")
            : (surfaceWindToggle ? surfaceWindToggle.closest("label") : null);

    const container =
        existingAnchor
            ? existingAnchor.parentElement
            : null;

    if (!container) {
        return;
    }

    for (const config of VECTOR_OVERLAY_CONFIG) {

        let toggle = document.getElementById(config.toggleId);
        let label = toggle ? toggle.closest("label") : null;

        if (!toggle) {
            label = document.createElement("label");
            label.style.display = "flex";
            label.style.alignItems = "center";
            label.style.gap = "6px";
            label.style.marginTop = "6px";

            toggle = document.createElement("input");
            toggle.type = "checkbox";
            toggle.id = config.toggleId;
            toggle.checked = false;

            label.appendChild(toggle);
            label.appendChild(
                document.createTextNode(` ${VECTOR_FIELDS[config.field].shortName}`)
            );

            container.appendChild(label);
        }

        vectorToggleElements[config.field] = toggle;

        if (label) {
            label.style.display = "flex";
            label.style.alignItems = "center";
            label.style.gap = "6px";

            let colorInput = label.querySelector(
                `input[type="color"][data-vector-field="${config.field}"]`
            );

            if (!colorInput) {
                colorInput = document.createElement("input");
                colorInput.type = "color";
                colorInput.value = VECTOR_FIELDS[config.field].defaultColor;
                colorInput.dataset.vectorField = config.field;
                colorInput.title = `Choose ${VECTOR_FIELDS[config.field].shortName} color`;
                colorInput.setAttribute(
                    "aria-label",
                    `Choose ${VECTOR_FIELDS[config.field].shortName} color`
                );
                colorInput.style.width = "28px";
                colorInput.style.height = "22px";
                colorInput.style.padding = "0";
                colorInput.style.border = "none";
                colorInput.style.background = "transparent";
                colorInput.style.cursor = "pointer";
                colorInput.addEventListener("click", event => event.stopPropagation());
                colorInput.addEventListener("pointerdown", event => event.stopPropagation());
                colorInput.style.marginLeft = "auto";
                label.appendChild(colorInput);
            }

            vectorColorElements[config.field] = colorInput;
        }
    }
}

ensureVectorControls();


/* =========================================================================================
   MSLP TOGGLE
   ========================================================================================= */

/*
 * Use the checkbox from index.html if present.
 *
 * If index.html does not have it yet, create it beside the other
 * independent overlays.
 */

let mslpToggle =
    document.getElementById(
        "mslp-toggle"
    );

if (!mslpToggle) {

    const overlayAnchor =
        srWind46Toggle
            ? srWind46Toggle.closest("label")
            : null;

    const overlayContainer =
        overlayAnchor
            ? overlayAnchor.parentElement
            : null;

    if (overlayContainer) {

        const label =
            document.createElement(
                "label"
            );

        label.style.display =
            "block";

        label.style.marginTop =
            "6px";

        mslpToggle =
            document.createElement(
                "input"
            );

        mslpToggle.type =
            "checkbox";

        mslpToggle.id =
            "mslp-toggle";

        mslpToggle.checked =
            false;

        label.appendChild(
            mslpToggle
        );

        label.appendChild(
            document.createTextNode(
                " Surface MSLP"
            )
        );

        overlayContainer.appendChild(
            label
        );

    }

}


/* =========================================================================================
   DCAPE TOGGLE
   ========================================================================================= */

let dcapeToggle =
    document.getElementById(
        "dcape-toggle"
    );


/* =========================================================================================
   WARM CLOUD DEPTH TOGGLE
   ========================================================================================= */

let warmCloudDepthToggle =
    document.getElementById(
        "warm-cloud-depth-toggle"
    );

if (!warmCloudDepthToggle) {

    const overlayAnchor =
        dcapeToggle
            ? dcapeToggle.closest("label")
            : (mslpToggle ? mslpToggle.closest("label") : null);

    const overlayContainer =
        overlayAnchor
            ? overlayAnchor.parentElement
            : null;

    if (overlayContainer) {

        const label = document.createElement("label");
        label.style.display = "block";
        label.style.marginTop = "6px";

        warmCloudDepthToggle = document.createElement("input");
        warmCloudDepthToggle.type = "checkbox";
        warmCloudDepthToggle.id = "warm-cloud-depth-toggle";
        warmCloudDepthToggle.checked = false;

        label.appendChild(warmCloudDepthToggle);
        label.appendChild(
            document.createTextNode(" Warm Cloud Depth")
        );

        overlayContainer.appendChild(label);
    }
}


/* =========================================================================================
   GEOPOTENTIAL HEIGHT TOGGLES
   ========================================================================================= */

const GEOPOTENTIAL_HEIGHT_OVERLAYS = [
    { field: "hght_925mb", stateKey: "hght925", toggleId: "hght-925mb-toggle", label: "925 mb Geopotential Height" },
    { field: "hght_850mb", stateKey: "hght850", toggleId: "hght-850mb-toggle", label: "850 mb Geopotential Height" },
    { field: "hght_700mb", stateKey: "hght700", toggleId: "hght-700mb-toggle", label: "700 mb Geopotential Height" },
    { field: "hght_500mb", stateKey: "hght500", toggleId: "hght-500mb-toggle", label: "500 mb Geopotential Height" },
    { field: "hght_250mb", stateKey: "hght250", toggleId: "hght-250mb-toggle", label: "250 mb Geopotential Height" }
];

const geopotentialHeightToggles = {};

const PRESSURE_TEMPERATURE_CONTOUR_OVERLAYS = [
    { field: "temperature_contours_925mb", stateKey: "tempContour925", toggleId: "temperature-contours-925mb-toggle", label: "925 mb Temperature Contours" },
    { field: "temperature_contours_850mb", stateKey: "tempContour850", toggleId: "temperature-contours-850mb-toggle", label: "850 mb Temperature Contours" },
    { field: "temperature_contours_700mb", stateKey: "tempContour700", toggleId: "temperature-contours-700mb-toggle", label: "700 mb Temperature Contours" },
    { field: "temperature_contours_500mb", stateKey: "tempContour500", toggleId: "temperature-contours-500mb-toggle", label: "500 mb Temperature Contours" },
    { field: "temperature_contours_250mb", stateKey: "tempContour250", toggleId: "temperature-contours-250mb-toggle", label: "250 mb Temperature Contours" }
];
const pressureTemperatureContourToggles = {};
for (const config of PRESSURE_TEMPERATURE_CONTOUR_OVERLAYS) {
    const toggle = document.getElementById(config.toggleId);
    if (toggle) pressureTemperatureContourToggles[config.stateKey] = toggle;
}

const FRONTOGENESIS_CONTOUR_OVERLAYS = [
    { field: "frontogenesis_925mb", stateKey: "frontogenesis925", toggleId: "frontogenesis-925mb-toggle", label: "925 mb Frontogenesis" },
    { field: "frontogenesis_850mb", stateKey: "frontogenesis850", toggleId: "frontogenesis-850mb-toggle", label: "850 mb Frontogenesis" },
    { field: "frontogenesis_700mb", stateKey: "frontogenesis700", toggleId: "frontogenesis-700mb-toggle", label: "700 mb Frontogenesis" }
];
const frontogenesisContourToggles = {};
for (const config of FRONTOGENESIS_CONTOUR_OVERLAYS) {
    const toggle = document.getElementById(config.toggleId);
    if (toggle) frontogenesisContourToggles[config.stateKey] = toggle;
}

{
    const overlayAnchor =
        warmCloudDepthToggle
            ? warmCloudDepthToggle.closest("label")
            : (dcapeToggle ? dcapeToggle.closest("label") : (mslpToggle ? mslpToggle.closest("label") : null));

    const overlayContainer =
        overlayAnchor
            ? overlayAnchor.parentElement
            : null;

    for (const config of GEOPOTENTIAL_HEIGHT_OVERLAYS) {

        let toggle =
            document.getElementById(config.toggleId);

        if (!toggle && overlayContainer) {

            const label =
                document.createElement("label");

            label.style.display = "block";
            label.style.marginTop = "6px";

            toggle =
                document.createElement("input");

            toggle.type = "checkbox";
            toggle.id = config.toggleId;
            toggle.checked = false;

            label.appendChild(toggle);
            label.appendChild(
                document.createTextNode(` ${config.label}`)
            );

            overlayContainer.appendChild(label);
        }

        geopotentialHeightToggles[config.stateKey] =
            toggle;
    }
}


/* =========================================================================================
   LCL HEIGHT CONTOUR TOGGLE
   ========================================================================================= */

const THERMODYNAMIC_CONTOUR_OVERLAYS = [
    { field: "sbcin_contours", stateKey: "sbcinContours", toggleId: "sbcin-contours-toggle", label: "SBCIN Contours" },
    { field: "mlcin_contours", stateKey: "mlcinContours", toggleId: "mlcin-contours-toggle", label: "MLCIN Contours" },
    { field: "mucin_contours", stateKey: "mucinContours", toggleId: "mucin-contours-toggle", label: "MUCIN Contours" },

    {
        field: "lcl_height",
        stateKey: "lclHeight",
        toggleId: "lcl-height-toggle",
        label: "LCL Height"
    },
    {
        field: "stp_eff_contours",
        stateKey: "stpEff",
        toggleId: "stp-eff-toggle",
        label: "Effective-Layer STP"
    },
    {
        field: "dcp_contours",
        stateKey: "dcpContours",
        toggleId: "dcp-contours-toggle",
        label: "Derecho Composite Parameter"
    },
    {
        field: "lhp_contours",
        stateKey: "lhpContours",
        toggleId: "lhp-contours-toggle",
        label: "Large Hail Parameter"
    },
    {
        field: "shp_contours",
        stateKey: "shpContours",
        toggleId: "shp-contours-toggle",
        label: "Significant Hail Parameter"
    },
    {
        field: "theta_2m_contours",
        stateKey: "thetaContours",
        toggleId: "theta-contours-toggle",
        label: "2 m Theta Contours"
    },
    {
        field: "thetae_2m_contours",
        stateKey: "thetaeContours",
        toggleId: "thetae-contours-toggle",
        label: "2 m Theta-e Contours"
    },

];

const thermodynamicContourToggles = {};

{
    const overlayAnchor =
        geopotentialHeightToggles.hght250
            ? geopotentialHeightToggles.hght250.closest("label")
            : (
                warmCloudDepthToggle
                    ? warmCloudDepthToggle.closest("label")
                    : null
            );

    const overlayContainer =
        overlayAnchor
            ? overlayAnchor.parentElement
            : null;

    for (const config of THERMODYNAMIC_CONTOUR_OVERLAYS) {

        let toggle =
            document.getElementById(config.toggleId);

        if (!toggle && overlayContainer) {

            const label =
                document.createElement("label");

            label.style.display = "block";
            label.style.marginTop = "6px";

            toggle =
                document.createElement("input");

            toggle.type = "checkbox";
            toggle.id = config.toggleId;
            toggle.checked = false;

            label.appendChild(toggle);
            label.appendChild(
                document.createTextNode(` ${config.label}`)
            );

            overlayContainer.appendChild(label);
        }

        thermodynamicContourToggles[config.stateKey] =
            toggle;
    }
}


/* =========================================================================================
   RUN / STATUS
   ========================================================================================= */

const runIdElement =
    document.getElementById("run-id");

const analysisTimeElement =
    document.getElementById("analysis-time");

const statusElement =
    document.getElementById("status");


/* =========================================================================================
   LEGEND
   ========================================================================================= */

/*
 * IMPORTANT:
 *
 * Your existing index.html uses:
 *
 *     #legend
 *     #legend-title
 *     #legend-bar
 *     #legend-labels
 *
 * We use THAT existing legend bar.
 *
 * We do NOT create "legend-canvas".
 *
 * That extra dynamically created canvas was responsible for the empty
 * rectangle that appeared above the actual color bar.
 */

const legend =
    document.getElementById("legend");

const legendTitle =
    document.getElementById("legend-title");

const legendCanvas =
    document.getElementById("legend-bar");

const legendCtx =
    legendCanvas
        ? legendCanvas.getContext("2d")
        : null;

const legendLabels =
    document.getElementById("legend-labels");

if (legend) legend.style.display = "none";


/* =========================================================================================
   CURSOR SAMPLE PANEL
   ========================================================================================= */

const cursorPanel =
    document.getElementById("cursor-panel");

const cursorSampleRows =
    document.getElementById("cursor-sample-rows");

const cursorSampleToggle =
    document.getElementById("cursor-sample-toggle");

let cursorSampleEnabled =
    cursorSampleToggle
        ? cursorSampleToggle.checked
        : false;


/* =========================================================================================
   ACTIVE-LAYER INFORMATION STRIP
   ========================================================================================= */

const activeLayersStrip =
    document.getElementById("active-layers-strip");

const activeLayersText =
    document.getElementById("active-layers-text");

function formatActiveLayer(name, units, displayType) {

    const unitText =
        units && String(units).trim()
            ? `${units}, `
            : "";

    return `${name} (${unitText}${displayType})`;
}

function getActiveLayerDescriptions() {

    const descriptions = [];

    if (
        activeField &&
        activeField !== "none" &&
        WEATHER_FIELDS[activeField]
    ) {

        const field = WEATHER_FIELDS[activeField];

        descriptions.push({
            text: formatActiveLayer(
                field.shortName || field.name,
                field.units || "",
                "fill"
            ),
            color: null
        });
    }

    const contourConfigs = [
        { field: "sfc_mslp", stateKey: "mslp", units: "mb" },
        { field: "dcape", stateKey: "dcape" },
        { field: "warm_cloud_depth", stateKey: "warmCloudDepth" },
        ...GEOPOTENTIAL_HEIGHT_OVERLAYS.map(config => ({
            field: config.field,
            stateKey: config.stateKey
        })),
        ...PRESSURE_TEMPERATURE_CONTOUR_OVERLAYS.map(config => ({
            field: config.field,
            stateKey: config.stateKey
        })),
        ...FRONTOGENESIS_CONTOUR_OVERLAYS.map(config => ({
            field: config.field,
            stateKey: config.stateKey
        })),
        ...THERMODYNAMIC_CONTOUR_OVERLAYS.map(config => ({
            field: config.field,
            stateKey: config.stateKey
        }))
    ];

    for (const config of contourConfigs) {

        if (!activeOverlays[config.stateKey]) {
            continue;
        }

        const field = CONTOUR_FIELDS[config.field];

        if (!field) {
            continue;
        }

        descriptions.push({
            text: formatActiveLayer(
                field.shortName || field.name,
                config.units !== undefined ? config.units : (field.units || ""),
                "contour"
            ),
            color: null
        });
    }

    for (const config of VECTOR_OVERLAY_CONFIG) {

        if (!activeOverlays[config.stateKey]) {
            continue;
        }

        const field = VECTOR_FIELDS[config.field];

        if (!field) {
            continue;
        }

        const isAxisSegments = field.renderType === "axis_segments";
        const isQVector = field.renderType === "arrows";
        descriptions.push({
            text: formatActiveLayer(
                field.shortName || field.name,
                (isAxisSegments || isQVector) ? "" : "kt",
                isAxisSegments ? "axes" : (isQVector ? "arrows" : "barbs")
            ),
            color: vectorColors[config.field] || field.defaultColor || "#000000"
        });
    }

    return descriptions;
}

function fitActiveLayersStrip() {

    if (!activeLayersStrip || !activeLayersText) {
        return;
    }

    let fontSize = 13;
    const minimumFontSize = 9.5;

    activeLayersStrip.style.fontSize = `${fontSize}px`;

    while (
        activeLayersText.scrollWidth > activeLayersStrip.clientWidth - 28 &&
        fontSize > minimumFontSize
    ) {
        fontSize -= 0.5;
        activeLayersStrip.style.fontSize = `${fontSize}px`;
    }
}

function updateActiveLayersStrip() {

    if (!activeLayersText) {
        return;
    }

    const descriptions =
        getActiveLayerDescriptions();

    activeLayersText.replaceChildren();

    function appendSeparator() {
        const separator = document.createElement("span");
        separator.className = "active-layer-separator";
        separator.textContent = " | ";
        activeLayersText.appendChild(separator);
    }

    descriptions.forEach((description, index) => {

        if (index > 0) {
            appendSeparator();
        }

        if (description.color) {
            const indicator = document.createElement("span");
            indicator.className = "active-layer-color-indicator";
            indicator.style.backgroundColor = description.color;
            indicator.setAttribute("aria-hidden", "true");
            activeLayersText.appendChild(indicator);
        }

        activeLayersText.appendChild(
            document.createTextNode(description.text)
        );
    });

    if (descriptions.length > 0) {
        appendSeparator();
    }

    const valid = document.createElement("span");
    valid.className = "active-layer-valid-time";
    valid.textContent = `Valid: ${formatAnalysisTime(currentAnalysisTime)}`;
    activeLayersText.appendChild(valid);

    requestAnimationFrame(fitActiveLayersStrip);
}


/* =========================================================================================
   MAP
   ========================================================================================= */

const map = new maplibregl.Map({

    container: "map",

    /* Keep the WebGL framebuffer available for Save PNG capture. */
    preserveDrawingBuffer: true,

    style: {

        version: 8,

        sources: {},

        layers: [

            {

                id: "background",

                type: "background",

                paint: {

                    "background-color":
                        "#ffffff"

                }

            }

        ]

    },

    center: [

        -100.75,

        41.1

    ],

    zoom: 6,

    minZoom: 3,

    maxZoom: 9,

    attributionControl: false,

    dragRotate: false,

    pitchWithRotate: false

});


map.dragRotate.disable();

map.touchZoomRotate.disableRotation();


map.addControl(

    new maplibregl.NavigationControl({

        showCompass: false,

        showZoom: true

    }),

    "top-right"

);


map.addControl(

    new maplibregl.AttributionControl({

        compact: true,

        customAttribution:
            "Geography: U.S. Census Bureau / us-atlas"

    })

);


/* =========================================================================================
   GEOGRAPHY DATA
   ========================================================================================= */

let countyFeatures = [];

let stateFeatures = [];

let cwaFeatures = [];

let cityFeatures = [];


/* =========================================================================================
   CANVAS SIZE
   ========================================================================================= */

function resizeCanvas(
    canvas
) {

    if (!canvas) {
        return;
    }


    const rect =
        mapWrapper.getBoundingClientRect();


    const dpr =
        window.devicePixelRatio || 1;


    const targetWidth =
        Math.round(
            rect.width *
            dpr
        );


    const targetHeight =
        Math.round(
            rect.height *
            dpr
        );


    if (
        canvas.width !==
            targetWidth ||

        canvas.height !==
            targetHeight
    ) {

        canvas.width =
            targetWidth;


        canvas.height =
            targetHeight;


        canvas.style.width =
            `${rect.width}px`;


        canvas.style.height =
            `${rect.height}px`;

    }

}


function prepareContext(
    canvas,
    ctx
) {

    if (
        !canvas ||
        !ctx
    ) {
        return;
    }


    resizeCanvas(
        canvas
    );


    const dpr =
        window.devicePixelRatio || 1;


    ctx.setTransform(

        dpr,

        0,

        0,

        dpr,

        0,

        0

    );


    ctx.clearRect(

        0,

        0,

        canvas.width /
            dpr,

        canvas.height /
            dpr

    );

}


function resizeAllCanvases() {

    resizeCanvas(
        weatherCanvas
    );


    resizeCanvas(
        vectorCanvas
    );


    resizeCanvas(
        contourCanvas
    );


    resizeCanvas(
        geographyCanvas
    );


    resizeCanvas(
        contourLabelCanvas
    );

}


/* =========================================================================================
   CAMERA / CANVAS TRACKING
   ========================================================================================= */

function captureCanvasCamera() {

    const bounds =
        map.getBounds();


    capturedCamera = {

        west:
            bounds.getWest(),

        east:
            bounds.getEast(),

        north:
            bounds.getNorth(),

        south:
            bounds.getSouth()

    };

}


function transformCanvasToCurrentCamera(
    canvas
) {

    if (
        !capturedCamera ||
        !canvas
    ) {
        return;
    }


    const northwest =
        map.project([

            capturedCamera.west,

            capturedCamera.north

        ]);


    const southeast =
        map.project([

            capturedCamera.east,

            capturedCamera.south

        ]);


    const rect =
        mapWrapper.getBoundingClientRect();


    if (
        rect.width <= 0 ||
        rect.height <= 0
    ) {

        return;

    }


    const scaleX =
        (
            southeast.x -
            northwest.x
        ) /
        rect.width;


    const scaleY =
        (
            southeast.y -
            northwest.y
        ) /
        rect.height;


    canvas.style.transformOrigin =
        "0 0";


    canvas.style.transform =
        `translate(${northwest.x}px, ${northwest.y}px) ` +
        `scale(${scaleX}, ${scaleY})`;

}


function transformNumericalCanvases() {

    // The holdover canvases remain attached to the map if the user resumes panning.
    for (const ghost of numericalHoldovers) {
        transformCanvasToCurrentCamera(ghost);
    }

    transformCanvasToCurrentCamera(
        weatherCanvas
    );


    transformCanvasToCurrentCamera(
        vectorCanvas
    );


    transformCanvasToCurrentCamera(
        contourCanvas
    );


    transformCanvasToCurrentCamera(
        contourLabelCanvas
    );

}


function resetNumericalCanvasTransforms() {

    const canvases = [

        weatherCanvas,

        vectorCanvas,

        contourCanvas,

        contourLabelCanvas

    ];


    for (
        const canvas
        of
        canvases
    ) {

        if (!canvas) {
            continue;
        }


        canvas.style.transform =
            "none";


        canvas.style.transformOrigin =
            "0 0";

    }

}


/* =========================================================================================
   KEEP-PREVIOUS-FRAME REDRAW

   Existing numerical renderers clear visible canvases before awaiting tiles.
   During a camera redraw, put a frozen copy above each numerical canvas so
   the previous image stays visible until ALL new canvases are ready.
   These snapshots are display-only; the original binary tiles, resolution,
   map geography, export behavior, and product sampling are unchanged.
   ========================================================================================= */
let numericalHoldovers = [];
let numericalHoldoverId = 0;

function beginNumericalHoldover() {
    // An in-flight redraw might still be active; reuse its visible snapshots.
    if (numericalHoldovers.length) return ++numericalHoldoverId;

    const sources = [weatherCanvas, vectorCanvas, contourCanvas, contourLabelCanvas];
    for (const source of sources) {
        if (!source || !source.width || !source.height) continue;
        const ghost = document.createElement("canvas");
        ghost.width = source.width;
        ghost.height = source.height;
        ghost.className = "numerical-frame-holdover";
        ghost.style.position = "absolute";
        ghost.style.left = "0";
        ghost.style.top = "0";
        ghost.style.width = source.style.width || "100%";
        ghost.style.height = source.style.height || "100%";
        ghost.style.pointerEvents = "none";
        ghost.style.zIndex = window.getComputedStyle(source).zIndex;
        ghost.style.transformOrigin = source.style.transformOrigin || "0 0";
        ghost.style.transform = source.style.transform || "none";
        ghost.getContext("2d").drawImage(source, 0, 0);
        // Same stacking layer, later DOM order: screenshot overlays the cleared canvas.
        source.insertAdjacentElement("afterend", ghost);
        numericalHoldovers.push(ghost);
    }
    return ++numericalHoldoverId;
}

function finishNumericalHoldover(token) {
    if (token !== numericalHoldoverId) return;
    for (const ghost of numericalHoldovers) ghost.remove();
    numericalHoldovers = [];
}

/* =========================================================================================
   FETCH JSON
   ========================================================================================= */

async function fetchJSON(url) {
    const immutableRunMetadata = /\/runs\/[^/]+\/.+metadata\.json(?:\?|$)/.test(url) ||
        /\/runs\/[^/]+\/metadata\.json(?:\?|$)/.test(url);
    const options = {cache: immutableRunMetadata ? "default" : "no-store"};
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                if (response.status !== 429 && response.status < 500) {
                    throw new Error(`HTTP ${response.status}: ${url}`);
                }
                lastError = new Error(`HTTP ${response.status}: ${url}`);
            } else {
                return await response.json();
            }
        } catch (error) {
            lastError = error;
            if (/HTTP 40[0-8]:/.test(error.message || "")) throw error;
        }
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
    }
    throw lastError || new Error(`Could not load ${url}`);
}


/* =========================================================================================
   LOAD RUN
   ========================================================================================= */

async function loadAvailableTimesManifest() {
    const manifest = await fetchJSON(`${S3_BASE_URL}/available_times.json?t=${Date.now()}`);
    const runs = Array.isArray(manifest.runs) ? manifest.runs : [];
    timelineState.availableRuns = runs
        .filter(item => item && item.run)
        .map(item => ({
            run: item.run,
            analysis_time: item.analysis_time || null,
            path: item.path || `runs/${item.run}/`
        }))
        .sort((a, b) => String(a.run).localeCompare(String(b.run)));
    timelineState.latestRun = manifest.latest || (timelineState.availableRuns.at(-1)?.run ?? null);
    return manifest;
}

function filteredTimelineRuns() {
    const runs = timelineState.availableRuns;
    if (!runs.length) return [];
    const latest = runs.at(-1);
    const latestMs = Date.parse(latest.analysis_time || runIdToIso(latest.run));
    const cutoff = latestMs - timelineState.historyHours * 3600000;
    return runs.filter(item => Date.parse(item.analysis_time || runIdToIso(item.run)) >= cutoff);
}

function runIdToIso(runId) {
    const match = /^(\d{4})(\d{2})(\d{2})_(\d{2})$/.exec(String(runId || ""));
    return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:00:00Z` : null;
}

function formatTimelineUtc(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("en-US", {
        weekday: "short", month: "short", day: "numeric", year: "numeric",
        timeZone: "UTC", hour: "2-digit", hour12: false
    }).format(date).replace(/, (\d{2})$/, ", $1Z");
}

async function loadRunMetadata(runId) {
    if (runMetadataCache.has(runId)) return runMetadataCache.get(runId);
    const promise = (async () => {
        const metadata = await fetchJSON(`${S3_BASE_URL}/runs/${runId}/metadata.json`);
        const fields = {};
        const vectors = {};
        const contours = {};
        const results = await Promise.allSettled([
            ...(metadata.fields || []).map(async fieldKey => {
                fields[fieldKey] = await fetchJSON(`${S3_BASE_URL}/runs/${runId}/${fieldKey}/metadata.json`);
            }),
            ...(metadata.overlays || []).map(async overlayKey => {
                const item = await fetchJSON(`${S3_BASE_URL}/runs/${runId}/overlays/${overlayKey}/metadata.json`);
                const isContour = item.type === "scalar_contour" ||
                    (item.display && item.display.type === "contour");
                if (isContour) contours[overlayKey] = item; else vectors[overlayKey] = item;
            })
        ]);
        const failures = results.filter(r => r.status === "rejected");
        if (failures.length) console.warn(`${failures.length} product metadata files unavailable for ${runId}:`,
            failures.slice(0, 5).map(r => r.reason));
        if (results.length && failures.length === results.length) {
            throw new Error(`No SPCOA product metadata could be loaded for ${runId}.`);
        }
        return { metadata, fields, vectors, contours };
    })();
    runMetadataCache.set(runId, promise);
    try {
        const resolved = await promise;
        runMetadataCache.set(runId, resolved);
        return resolved;
    } catch (error) {
        runMetadataCache.delete(runId);
        throw error;
    }
}

async function applyRun(runItem, { render = true, preload = true } = {}) {
    if (!runItem || !runItem.run || timelineState.switching) return false;
    if (runItem.run === currentRun && runMetadata) {
        updateTimelineUi();
        if (preload) scheduleAdjacentPreload();
        return true;
    }
    timelineState.switching = true;
    stopPlaybackTimer();
    if (statusElement) statusElement.textContent = `Loading ${runItem.run}...`;
    try {
        const bundle = await loadRunMetadata(runItem.run);
        invalidateNumericalRenders();
        currentRun = runItem.run;
        currentAnalysisTime = runItem.analysis_time || bundle.metadata.analysis_time || runIdToIso(runItem.run);
        runMetadata = bundle.metadata;
        fieldMetadata = bundle.fields;
        vectorMetadata = bundle.vectors;
        contourMetadata = bundle.contours;
        if (runIdElement) runIdElement.textContent = currentRun;
        if (analysisTimeElement) analysisTimeElement.textContent = formatAnalysisTime(currentAnalysisTime);
        const windowRuns = filteredTimelineRuns();
        timelineState.currentIndex = windowRuns.findIndex(item => item.run === currentRun);
        timelineState.isLive = currentRun === timelineState.latestRun;
        updateTimelineUi();
        requestAnimationFrame(updateActiveLayersStrip);
        if (render) await renderAll();
        if (statusElement) statusElement.textContent = `Loaded ${currentRun}`;
        if (currentRun === timelineState.latestRun) timelineState.pendingLiveSwitch = false;
        if (preload) scheduleAdjacentPreload();
        return true;
    } catch (error) {
        console.error(`Failed to load run ${runItem.run}:`, error);
        if (statusElement) statusElement.textContent = `Could not load ${runItem.run}`;
        return false;
    } finally {
        timelineState.switching = false;
        if (timelineState.playing) scheduleNextPlaybackFrame();
    }
}

async function loadLatestRun() {
    if (statusElement) statusElement.textContent = "Loading timeline...";
    let manifest;
    try {
        manifest = await loadAvailableTimesManifest();
    } catch (error) {
        console.warn("available_times.json unavailable; falling back to latest.json", error);
        const latest = await fetchJSON(`${S3_BASE_URL}/latest.json?t=${Date.now()}`);
        timelineState.availableRuns = [{ run: latest.run, analysis_time: latest.analysis_time || runIdToIso(latest.run) }];
        timelineState.latestRun = latest.run;
    }
    const latestItem = timelineState.availableRuns.find(item => item.run === timelineState.latestRun) || timelineState.availableRuns.at(-1);
    if (!latestItem) throw new Error("No SPCOA analyses are available.");
    const loaded = await applyRun(latestItem, { render: false, preload: false });
    if (!loaded) throw new Error(`Could not initialize analysis ${latestItem.run}`);
}

function updateTimelineUi() {
    const runs = filteredTimelineRuns();
    const index = Math.max(0, runs.findIndex(item => item.run === currentRun));
    timelineState.currentIndex = runs.length ? index : -1;
    timelineState.isLive = currentRun === timelineState.latestRun;
    if (timelineSlider) {
        timelineSlider.min = "0";
        timelineSlider.max = String(Math.max(0, runs.length - 1));
        timelineSlider.step = "1";
        timelineSlider.value = String(Math.max(0, timelineState.currentIndex));
        timelineSlider.disabled = runs.length <= 1;
    }
    if (timelinePrevButton) timelinePrevButton.disabled = timelineState.currentIndex <= 0;
    if (timelineNextButton) timelineNextButton.disabled = timelineState.currentIndex < 0 || timelineState.currentIndex >= runs.length - 1;
    if (timelinePlayButton) {
        timelinePlayButton.textContent = timelineState.playing ? "❚❚" : "▶";
        timelinePlayButton.title = timelineState.playing ? "Pause animation" : "Play animation";
    }
    if (timelineSpeedLabel) timelineSpeedLabel.textContent = `${timelineState.playbackSpeed.toFixed(timelineState.playbackSpeed % 1 ? 2 : 1)}×`;
    if (timelineTimeLabel) timelineTimeLabel.textContent = formatTimelineUtc(currentAnalysisTime);
    if (timelineLoopToggle) timelineLoopToggle.checked = timelineState.looping;
    if (timelineLiveButton) timelineLiveButton.classList.toggle("active", timelineState.isLive);
    if (timelineHistorySelect) timelineHistorySelect.value = String(timelineState.historyHours);
}

function stopPlaybackTimer() {
    if (timelineState.playTimer) clearTimeout(timelineState.playTimer);
    timelineState.playTimer = null;
}

function playbackDelayMs() {
    const newest = currentRun === timelineState.latestRun;
    return Math.round((PLAYBACK_BASE_MS / timelineState.playbackSpeed) * (newest ? 1.45 : 1));
}

function scheduleNextPlaybackFrame() {
    stopPlaybackTimer();
    if (!timelineState.playing || timelineState.switching) return;
    timelineState.playTimer = setTimeout(() => advanceTimeline(1, true), playbackDelayMs());
}

function setPlaying(value) {
    timelineState.playing = Boolean(value);
    stopPlaybackTimer();
    updateTimelineUi();
    if (timelineState.playing) scheduleNextPlaybackFrame();
}

async function advanceTimeline(direction, fromPlayback = false) {
    const runs = filteredTimelineRuns();
    if (!runs.length || timelineState.switching) return;
    let index = runs.findIndex(item => item.run === currentRun);
    if (index < 0) index = runs.length - 1;
    let next = index + direction;
    if (next >= runs.length) {
        if (fromPlayback && timelineState.looping) next = 0;
        else { if (fromPlayback) setPlaying(false); return; }
    }
    if (next < 0) return;
    if (!fromPlayback) {
        setPlaying(false);
        timelineState.pendingLiveSwitch = false;
    }
    await applyRun(runs[next]);
}

function selectedProductKeys() {
    const scalar = activeField && activeField !== "none" ? [activeField] : [];
    const vectors = VECTOR_OVERLAY_CONFIG.filter(c => activeOverlays[c.stateKey]).map(c => c.field);
    const contours = [
        ...GEOPOTENTIAL_HEIGHT_OVERLAYS,
        ...PRESSURE_TEMPERATURE_CONTOUR_OVERLAYS,
        ...FRONTOGENESIS_CONTOUR_OVERLAYS,
        ...THERMODYNAMIC_CONTOUR_OVERLAYS
    ].filter(c => activeOverlays[c.stateKey]).map(c => c.field);
    if (activeOverlays.mslp) contours.push("sfc_mslp");
    if (activeOverlays.dcape) contours.push("dcape");
    if (activeOverlays.warmCloudDepth) contours.push("warm_cloud_depth");
    return { scalar: [...new Set(scalar)], vectors: [...new Set(vectors)], contours: [...new Set(contours)] };
}

async function preloadRunProducts(runItem) {
    if (!runItem || !runItem.run || runItem.run === currentRun) return;
    const run = runItem.run;
    const z = getDataZoom();
    const products = selectedProductKeys();
    const jobs = [];
    for (const field of products.scalar) jobs.push(preloadScalarTiles(field, z, run));
    for (const field of products.vectors) jobs.push(preloadVectorTiles(field, z, run));
    for (const field of products.contours) jobs.push(preloadContourTiles(field, z, run));
    await Promise.allSettled(jobs);
}

function scheduleAdjacentPreload() {
    const runs = filteredTimelineRuns();
    const index = runs.findIndex(item => item.run === currentRun);
    if (index < 0) return;
    const candidates = timelineState.playing
        ? [runs[index + 1], runs[index + 2], runs[index - 1]]
        : [runs[index + 1], runs[index - 1]];
    const startPreload = () => candidates.filter(Boolean).forEach(item => preloadRunProducts(item));
    if ("requestIdleCallback" in window) {
        window.requestIdleCallback(startPreload, { timeout: 350 });
    } else {
        setTimeout(startPreload, 120);
    }
}

async function refreshAvailableTimes() {
    try {
        if (document.hidden || timelineState.switching) return;
        const wasLive = timelineState.isLive;
        const oldLatest = timelineState.latestRun;
        await loadAvailableTimesManifest();
        const followLive = wasLive || timelineState.pendingLiveSwitch ||
            (oldLatest && currentRun === oldLatest);
        if (followLive && timelineState.latestRun && timelineState.latestRun !== currentRun) {
            timelineState.pendingLiveSwitch = true;
            const latest = timelineState.availableRuns.find(item => item.run === timelineState.latestRun);
            if (latest) await applyRun(latest);
        }
        updateTimelineUi();
    } catch (error) {
        console.warn("Timeline manifest refresh failed:", error);
    }
}

function bindTimelineControls() {
    if (timelinePlayButton) timelinePlayButton.addEventListener("click", () => setPlaying(!timelineState.playing));
    if (timelinePrevButton) timelinePrevButton.addEventListener("click", () => advanceTimeline(-1));
    if (timelineNextButton) timelineNextButton.addEventListener("click", () => advanceTimeline(1));
    if (timelineSlider) {
        // Scrubbing should feel immediate without starting a full tile/render cycle for
        // every pointer movement. While dragging, update only the UTC readout.
        timelineSlider.addEventListener("input", event => {
            const requestedIndex = Number(event.target.value);
            const runs = filteredTimelineRuns();
            const item = runs[requestedIndex];
            if (timelineState.playing) {
                timelineState.playing = false;
                stopPlaybackTimer();
                if (timelinePlayButton) {
                    timelinePlayButton.textContent = "▶";
                    timelinePlayButton.title = "Play animation";
                }
            }
            if (item && timelineTimeLabel) {
                timelineTimeLabel.textContent = formatTimelineUtc(item.analysis_time || runIdToIso(item.run));
            }
        });

        // Load/render once the user commits the scrub position (mouse/touch release
        // or keyboard change), rather than repeatedly while the thumb is moving.
        timelineSlider.addEventListener("change", async event => {
            const requestedIndex = Number(event.target.value);
            const runs = filteredTimelineRuns();
            const item = runs[requestedIndex];
            if (item) {
                timelineState.pendingLiveSwitch = false;
                await applyRun(item);
            } else updateTimelineUi();
        });
    }
    if (timelineLoopToggle) timelineLoopToggle.addEventListener("change", event => { timelineState.looping = event.target.checked; updateTimelineUi(); });
    if (timelineLiveButton) timelineLiveButton.addEventListener("click", async () => {
        setPlaying(false);
        timelineState.pendingLiveSwitch = true;
        const item = timelineState.availableRuns.find(x => x.run === timelineState.latestRun) || timelineState.availableRuns.at(-1);
        if (item) await applyRun(item);
    });
    if (timelineHistorySelect) timelineHistorySelect.addEventListener("change", async event => {
        // Capture the user's choice BEFORE setPlaying(false) refreshes the select element.
        const requestedHours = Number(event.target.value) || 12;
        setPlaying(false);
        timelineState.historyHours = requestedHours;
        const runs = filteredTimelineRuns();
        if (!runs.some(item => item.run === currentRun) && runs.length) await applyRun(runs[0]);
        else updateTimelineUi();
        scheduleAdjacentPreload();
    });
    const speeds = [0.25, 0.5, 1.0, 1.5, 2.0];
    const changeSpeed = delta => {
        let i = speeds.indexOf(timelineState.playbackSpeed);
        if (i < 0) i = 2;
        timelineState.playbackSpeed = speeds[Math.max(0, Math.min(speeds.length - 1, i + delta))];
        updateTimelineUi();
        if (timelineState.playing) scheduleNextPlaybackFrame();
    };
    if (timelineSpeedDownButton) timelineSpeedDownButton.addEventListener("click", () => changeSpeed(-1));
    if (timelineSpeedUpButton) timelineSpeedUpButton.addEventListener("click", () => changeSpeed(1));
}

/* =========================================================================================
   FORMAT ANALYSIS TIME
   ========================================================================================= */

function formatAnalysisTime(
    value
) {

    if (!value) {
        return "--";
    }


    const date =
        new Date(
            value
        );


    if (
        Number.isNaN(
            date.getTime()
        )
    ) {

        return value;

    }


    const month =
        String(
            date.getUTCMonth() + 1
        ).padStart(
            2,
            "0"
        );


    const day =
        String(
            date.getUTCDate()
        ).padStart(
            2,
            "0"
        );


    const year =
        date.getUTCFullYear();


    const hour =
        String(
            date.getUTCHours()
        ).padStart(
            2,
            "0"
        );


    return (
        `${month}/${day}/${year} ${hour}Z`
    );

}


/* =========================================================================================
   DATA TILE ZOOM
   ========================================================================================= */

function getDataZoom() {

    const zoom =
        map.getZoom();


    if (
        zoom < 4.5
    ) {

        return 4;

    }


    if (
        zoom < 5.5
    ) {

        return 5;

    }


    if (
        zoom < 6.5
    ) {

        return 6;

    }


    return 7;

}


/* =========================================================================================
   WEB MERCATOR HELPERS
   ========================================================================================= */

function lonToTileX(
    lon,
    zoom
) {

    const n =
        2 ** zoom;


    return (
        (
            lon + 180
        ) /
        360
    ) *
    n;

}


function latToTileY(
    lat,
    zoom
) {

    const clippedLat =
        Math.max(

            -85.05112878,

            Math.min(

                85.05112878,

                lat

            )

        );


    const latRad =
        clippedLat *
        Math.PI /
        180;


    const n =
        2 ** zoom;


    return (
        (
            1 -
            Math.asinh(
                Math.tan(
                    latRad
                )
            ) /
            Math.PI
        ) /
        2
    ) *
    n;

}


function normalizeTileX(
    x,
    zoom
) {

    const n =
        2 ** zoom;


    return (
        (
            x % n
        ) +
        n
    ) %
    n;

}


/* =========================================================================================
   TILE CACHE KEYS
   ========================================================================================= */

function scalarTileKey(
    field,
    run,
    z,
    x,
    y
) {

    return (
        `${field}:${run}:${z}/${x}/${y}`
    );

}


function vectorTileKey(
    field,
    run,
    z,
    x,
    y
) {

    return (
        `${field}:${run}:${z}/${x}/${y}`
    );

}


function contourTileKey(
    field,
    run,
    z,
    x,
    y
) {

    return (
        `${field}:${run}:${z}/${x}/${y}`
    );

}


/* =========================================================================================
   VISIBLE TILE RANGE
   ========================================================================================= */

function getVisibleTileRange(
    zoom,
    buffer = 2
) {

    const bounds =
        map.getBounds();


    const n =
        2 ** zoom;


    let x0 =
        Math.floor(
            lonToTileX(
                bounds.getWest(),
                zoom
            )
        ) -
        buffer;


    let x1 =
        Math.floor(
            lonToTileX(
                bounds.getEast(),
                zoom
            )
        ) +
        buffer;


    let y0 =
        Math.floor(
            latToTileY(
                bounds.getNorth(),
                zoom
            )
        ) -
        buffer;


    let y1 =
        Math.floor(
            latToTileY(
                bounds.getSouth(),
                zoom
            )
        ) +
        buffer;


    y0 =
        Math.max(
            0,
            y0
        );


    y1 =
        Math.min(
            n - 1,
            y1
        );


    return {

        x0,

        x1,

        y0,

        y1

    };

}


/* =========================================================================================
   ENCODING HELPERS
   ========================================================================================= */

function getEncoding(
    metadata,
    defaultScale = 1,
    defaultOffset = 0,
    defaultNoData = SCALAR_NODATA
) {

    const encoding =
        metadata &&
        metadata.encoding
            ? metadata.encoding
            : {};


    const scale =
        Number.isFinite(
            Number(
                encoding.scale
            )
        )
            ? Number(
                encoding.scale
            )
            : defaultScale;


    const offset =
        Number.isFinite(
            Number(
                encoding.offset
            )
        )
            ? Number(
                encoding.offset
            )
            : defaultOffset;


    const nodata =
        encoding.nodata !== undefined
            ? Number(
                encoding.nodata
            )
            : defaultNoData;


    return {

        scale,

        offset,

        nodata

    };

}


/* =========================================================================================
   LOAD SCALAR TILE
   ========================================================================================= */

async function loadScalarTile(field, z, x, y, run = currentRun, priority = 0) {
    if (!run) return null;
    const n = 2 ** z;
    if (y < 0 || y >= n) return null;
    const wrappedX = normalizeTileX(x, z);
    const key = scalarTileKey(field, run, z, wrappedX, y);

    if (scalarTileCache.has(key)) {
        touchNumericalTile("scalar", key);
        return await scalarTileCache.get(key);
    }
    if (!canRetryMissingTile("scalar", key)) return null;

    const url = `${S3_BASE_URL}/runs/${run}/${field}/z${z}/${wrappedX}/${y}.bin`;
    const promise = (async () => {
        const buffer = await queueNumericalTileFetch(url, priority);
        if (!buffer) return null;
        if (buffer.byteLength !== 131072) {
            console.warn("Unexpected scalar tile size:", field, z, wrappedX, y, buffer.byteLength);
            return null;
        }
        return new Uint16Array(buffer);
    })();
    scalarTileCache.set(key, promise);

    const tile = await promise;
    if (scalarTileCache.get(key) === promise) {
        if (tile) {
            scalarTileCache.set(key, tile);
            missingNumericalTiles.delete("scalar:" + key);
            rememberNumericalTile("scalar", scalarTileCache, key, tile);
        } else {
            scalarTileCache.delete(key);
            markMissingTile("scalar", key);
        }
    }
    return tile;
}


/* =========================================================================================
   LOAD VECTOR TILE
   ========================================================================================= */

async function loadVectorTile(field, z, x, y, run = currentRun, priority = 0) {
    if (!run) return null;
    const n = 2 ** z;
    if (y < 0 || y >= n) return null;
    const wrappedX = normalizeTileX(x, z);
    const key = vectorTileKey(field, run, z, wrappedX, y);

    if (vectorTileCache.has(key)) {
        touchNumericalTile("vector", key);
        return await vectorTileCache.get(key);
    }
    if (!canRetryMissingTile("vector", key)) return null;

    const url = `${S3_BASE_URL}/runs/${run}/overlays/${field}/z${z}/${wrappedX}/${y}.bin`;
    const promise = (async () => {
        const buffer = await queueNumericalTileFetch(url, priority);
        if (!buffer) return null;
        if (buffer.byteLength !== 262144) {
            console.warn("Unexpected vector tile size:", field, z, wrappedX, y, buffer.byteLength);
            return null;
        }
        return new Int16Array(buffer);
    })();
    vectorTileCache.set(key, promise);

    const tile = await promise;
    if (vectorTileCache.get(key) === promise) {
        if (tile) {
            vectorTileCache.set(key, tile);
            missingNumericalTiles.delete("vector:" + key);
            rememberNumericalTile("vector", vectorTileCache, key, tile);
        } else {
            vectorTileCache.delete(key);
            markMissingTile("vector", key);
        }
    }
    return tile;
}


/* =========================================================================================
   LOAD CONTOUR TILE
   ========================================================================================= */

async function loadContourTile(field, z, x, y, run = currentRun, priority = 0) {
    if (!run) return null;
    const n = 2 ** z;
    if (y < 0 || y >= n) return null;
    const wrappedX = normalizeTileX(x, z);
    const key = contourTileKey(field, run, z, wrappedX, y);

    if (contourTileCache.has(key)) {
        touchNumericalTile("contour", key);
        return await contourTileCache.get(key);
    }
    if (!canRetryMissingTile("contour", key)) return null;

    const url = `${S3_BASE_URL}/runs/${run}/overlays/${field}/z${z}/${wrappedX}/${y}.bin`;
    const promise = (async () => {
        const buffer = await queueNumericalTileFetch(url, priority);
        if (!buffer) return null;
        if (buffer.byteLength !== 131072) {
            console.warn("Unexpected contour tile size:", field, z, wrappedX, y, buffer.byteLength);
            return null;
        }
        return new Uint16Array(buffer);
    })();
    contourTileCache.set(key, promise);

    const tile = await promise;
    if (contourTileCache.get(key) === promise) {
        if (tile) {
            contourTileCache.set(key, tile);
            missingNumericalTiles.delete("contour:" + key);
            rememberNumericalTile("contour", contourTileCache, key, tile);
        } else {
            contourTileCache.delete(key);
            markMissingTile("contour", key);
        }
    }
    return tile;
}


/* =========================================================================================
   PRELOAD SCALAR TILES
   ========================================================================================= */

async function preloadScalarTiles(field, z, run = currentRun) {
    const range = getVisibleTileRange(z, 1);
    const ordered = priorityOrderedTileCoordinates(z, range);
    await Promise.all(ordered.map(tile =>
        loadScalarTile(field, z, tile.x, tile.y, run,
            run !== currentRun ? 7 : (tile.onScreen ? 0 : 3))));
}


/* =========================================================================================
   PRELOAD VECTOR TILES
   ========================================================================================= */

async function preloadVectorTiles(field, z, run = currentRun) {
    const range = getVisibleTileRange(z, 1);
    const ordered = priorityOrderedTileCoordinates(z, range);
    await Promise.all(ordered.map(tile =>
        loadVectorTile(field, z, tile.x, tile.y, run,
            run !== currentRun ? 7 : (tile.onScreen ? 0 : 3))));
}


/* =========================================================================================
   PRELOAD CONTOUR TILES
   ========================================================================================= */

async function preloadContourTiles(field, z, run = currentRun) {
    const range = getVisibleTileRange(z, 1);
    const ordered = priorityOrderedTileCoordinates(z, range);
    await Promise.all(ordered.map(tile =>
        loadContourTile(field, z, tile.x, tile.y, run,
            run !== currentRun ? 7 : (tile.onScreen ? 0 : 3))));
}


/* =========================================================================================
   GET CACHED SCALAR TILE
   ========================================================================================= */

function getCachedScalarTile(
    field,
    z,
    x,
    y
) {

    const n =
        2 ** z;


    if (
        y < 0 ||
        y >= n
    ) {

        return null;

    }


    const wrappedX =
        normalizeTileX(
            x,
            z
        );


    const key =
        scalarTileKey(

            field,

            currentRun,

            z,

            wrappedX,

            y

        );


    const cached =
        scalarTileCache.get(
            key
        );


    /*
     * A Promise means the tile is still loading.
     */
    if (
        !cached ||
        typeof cached.then ===
            "function"
    ) {

        return null;

    }


    return cached;

}


/* =========================================================================================
   GET CACHED VECTOR TILE
   ========================================================================================= */

function getCachedVectorTile(
    field,
    z,
    x,
    y
) {

    const n =
        2 ** z;


    if (
        y < 0 ||
        y >= n
    ) {

        return null;

    }


    const wrappedX =
        normalizeTileX(
            x,
            z
        );


    const key =
        vectorTileKey(

            field,

            currentRun,

            z,

            wrappedX,

            y

        );


    const cached =
        vectorTileCache.get(
            key
        );


    if (
        !cached ||
        typeof cached.then ===
            "function"
    ) {

        return null;

    }


    return cached;

}


/* =========================================================================================
   GET CACHED CONTOUR TILE
   ========================================================================================= */

function getCachedContourTile(
    field,
    z,
    x,
    y
) {

    const n =
        2 ** z;


    if (
        y < 0 ||
        y >= n
    ) {

        return null;

    }


    const wrappedX =
        normalizeTileX(
            x,
            z
        );


    const key =
        contourTileKey(

            field,

            currentRun,

            z,

            wrappedX,

            y

        );


    const cached =
        contourTileCache.get(
            key
        );


    if (
        !cached ||
        typeof cached.then ===
            "function"
    ) {

        return null;

    }


    return cached;

}


/* =========================================================================================
   RAW SCALAR PIXEL
   ========================================================================================= */

function getRawScalarPixel(
    field,
    z,
    globalPixelX,
    globalPixelY,
    contour = false
) {

    const worldPixels =
        TILE_SIZE *
        (
            2 ** z
        );


    /*
     * Wrap longitude around the Web Mercator world.
     */
    let gx =
        globalPixelX;


    gx =
        (
            (
                gx %
                worldPixels
            ) +
            worldPixels
        ) %
        worldPixels;


    /*
     * Latitude does not wrap.
     */
    if (
        globalPixelY < 0 ||
        globalPixelY >=
            worldPixels
    ) {

        return null;

    }


    const tileX =
        Math.floor(
            gx /
            TILE_SIZE
        );


    const tileY =
        Math.floor(
            globalPixelY /
            TILE_SIZE
        );


    const pixelX =
        Math.floor(
            gx -
            tileX *
            TILE_SIZE
        );


    const pixelY =
        Math.floor(
            globalPixelY -
            tileY *
            TILE_SIZE
        );


    const tile =
        contour
            ? getCachedContourTile(

                field,

                z,

                tileX,

                tileY

            )
            : getCachedScalarTile(

                field,

                z,

                tileX,

                tileY

            );


    if (!tile) {

        return null;

    }


    const index =
        pixelY *
        TILE_SIZE +
        pixelX;


    const raw =
        tile[index];


    const metadata =
        contour
            ? contourMetadata[field]
            : fieldMetadata[field];


    const encoding =
        getEncoding(
            metadata
        );


    if (
        raw ===
            encoding.nodata ||

        raw ===
            SCALAR_NODATA
    ) {

        return null;

    }


    return (
        raw *
        encoding.scale +
        encoding.offset
    );

}


/* =========================================================================================
   BILINEAR SCALAR SAMPLING
   ========================================================================================= */

function sampleScalar(
    field,
    lon,
    lat,
    z,
    contour = false
) {

    const tileXF =
        lonToTileX(
            lon,
            z
        );


    const tileYF =
        latToTileY(
            lat,
            z
        );


    const gx =
        tileXF *
        TILE_SIZE;


    const gy =
        tileYF *
        TILE_SIZE;


    const x0 =
        Math.floor(
            gx
        );


    const y0 =
        Math.floor(
            gy
        );


    const fx =
        gx -
        x0;


    const fy =
        gy -
        y0;


    const q00 =
        getRawScalarPixel(

            field,

            z,

            x0,

            y0,

            contour

        );


    const q10 =
        getRawScalarPixel(

            field,

            z,

            x0 + 1,

            y0,

            contour

        );


    const q01 =
        getRawScalarPixel(

            field,

            z,

            x0,

            y0 + 1,

            contour

        );


    const q11 =
        getRawScalarPixel(

            field,

            z,

            x0 + 1,

            y0 + 1,

            contour

        );


    /*
     * Require all four neighboring points for true numerical
     * bilinear interpolation.
     */
    if (
        q00 === null ||
        q10 === null ||
        q01 === null ||
        q11 === null
    ) {

        return null;

    }


    const top =
        q00 *
        (
            1 - fx
        ) +
        q10 *
        fx;


    const bottom =
        q01 *
        (
            1 - fx
        ) +
        q11 *
        fx;


    return (
        top *
        (
            1 - fy
        ) +
        bottom *
        fy
    );

}


/* =========================================================================================
   RAW VECTOR PIXEL
   ========================================================================================= */

function getRawVectorPixel(
    field,
    z,
    globalPixelX,
    globalPixelY
) {

    const worldPixels =
        TILE_SIZE *
        (
            2 ** z
        );


    let gx =
        globalPixelX;


    gx =
        (
            (
                gx %
                worldPixels
            ) +
            worldPixels
        ) %
        worldPixels;


    if (
        globalPixelY < 0 ||
        globalPixelY >=
            worldPixels
    ) {

        return null;

    }


    const tileX =
        Math.floor(
            gx /
            TILE_SIZE
        );


    const tileY =
        Math.floor(
            globalPixelY /
            TILE_SIZE
        );


    const pixelX =
        Math.floor(
            gx -
            tileX *
            TILE_SIZE
        );


    const pixelY =
        Math.floor(
            globalPixelY -
            tileY *
            TILE_SIZE
        );


    const tile =
        getCachedVectorTile(

            field,

            z,

            tileX,

            tileY

        );


    if (!tile) {

        return null;

    }


    /*
     * Vector data are interleaved:
     *
     *   U0,V0,U1,V1,...
     */
    const index =
        (
            pixelY *
            TILE_SIZE +
            pixelX
        ) *
        2;


    const rawU =
        tile[index];


    const rawV =
        tile[index + 1];


    const metadata =
        vectorMetadata[field];


    const encoding =
        getEncoding(

            metadata,

            0.1,

            0,

            VECTOR_NODATA

        );


    if (
        rawU ===
            encoding.nodata ||

        rawV ===
            encoding.nodata ||

        rawU ===
            VECTOR_NODATA ||

        rawV ===
            VECTOR_NODATA
    ) {

        return null;

    }


    return {

        u:
            rawU *
            encoding.scale +
            encoding.offset,

        v:
            rawV *
            encoding.scale +
            encoding.offset

    };

}


/* =========================================================================================
   BILINEAR VECTOR SAMPLING
   ========================================================================================= */

function sampleVector(
    field,
    lon,
    lat,
    z
) {

    const tileXF =
        lonToTileX(
            lon,
            z
        );


    const tileYF =
        latToTileY(
            lat,
            z
        );


    const gx =
        tileXF *
        TILE_SIZE;


    const gy =
        tileYF *
        TILE_SIZE;


    const x0 =
        Math.floor(
            gx
        );


    const y0 =
        Math.floor(
            gy
        );


    const fx =
        gx -
        x0;


    const fy =
        gy -
        y0;


    const q00 =
        getRawVectorPixel(

            field,

            z,

            x0,

            y0

        );


    const q10 =
        getRawVectorPixel(

            field,

            z,

            x0 + 1,

            y0

        );


    const q01 =
        getRawVectorPixel(

            field,

            z,

            x0,

            y0 + 1

        );


    const q11 =
        getRawVectorPixel(

            field,

            z,

            x0 + 1,

            y0 + 1

        );


    if (
        !q00 ||
        !q10 ||
        !q01 ||
        !q11
    ) {

        return null;

    }


    const interpolateComponent =
        component => {

            const top =
                q00[component] *
                (
                    1 - fx
                ) +
                q10[component] *
                fx;


            const bottom =
                q01[component] *
                (
                    1 - fx
                ) +
                q11[component] *
                fx;


            return (
                top *
                (
                    1 - fy
                ) +
                bottom *
                fy
            );

        };


    return {

        u:
            interpolateComponent(
                "u"
            ),

        v:
            interpolateComponent(
                "v"
            )

    };

}


/* =========================================================================================
   COLOR UTILITIES
   ========================================================================================= */

function hexToRgb(
    hex
) {

    const clean =
        hex.replace(
            "#",
            ""
        );


    return {

        r:
            parseInt(
                clean.substring(
                    0,
                    2
                ),
                16
            ),

        g:
            parseInt(
                clean.substring(
                    2,
                    4
                ),
                16
            ),

        b:
            parseInt(
                clean.substring(
                    4,
                    6
                ),
                16
            )

    };

}


const CAPE_RGB =
    CAPE_COLORS.map(
        hexToRgb
    );


const CAPE_03KM_RGB =
    CAPE_03KM_COLORS.map(
        hexToRgb
    );


const DEWPOINT_RGB =
    DEWPOINT_COLORS.map(
        hexToRgb
    );

const TEMPERATURE_RGB =
    TEMPERATURE_COLORS.map(
        hexToRgb
    );

const PRESSURE_TEMPERATURE_RGB =
    PRESSURE_TEMPERATURE_COLORS.map(color => {
        const match = color.match(/\d+/g).map(Number);
        return { r: match[0], g: match[1], b: match[2] };
    });

const TEMPERATURE_ADVECTION_RGB =
    TEMPERATURE_ADVECTION_COLORS.map(color => {
        if (color.startsWith("rgb(")) {
            const match = color.match(/\d+/g).map(Number);
            return { r: match[0], g: match[1], b: match[2] };
        }
        return hexToRgb(color);
    });

const LAPSE_RATE_RGB =
    LAPSE_RATE_COLORS.map(
        hexToRgb
    );

const SRH_RGB =
    SRH_COLORS.map(
        hexToRgb
    );

const EHI_RGB =
    EHI_COLORS.map(
        hexToRgb
    );

const RELATIVE_VORTICITY_RGB =
    RELATIVE_VORTICITY_COLORS.map(
        hexToRgb
    );

const THETAE_RGB =
    THETAE_COLORS.map(
        hexToRgb
    );

const RH_RGB =
    RH_COLORS.map(
        hexToRgb
    );


const MIDLEVEL_WIND_RGB =
    MIDLEVEL_WIND_COLORS.map(
        hexToRgb
    );

const WIND_500_RGB =
    WIND_500_COLORS.map(
        hexToRgb
    );

const WIND_250_RGB =
    WIND_250_COLORS.map(
        hexToRgb
    );


const PWAT_RGB =
    PWAT_COLORS.map(
        hexToRgb
    );

const STP_RGB =
    STP_COLORS.map(
        hexToRgb
    );


const SCP_RGB =
    SCP_COLORS.map(
        hexToRgb
    );


/* =========================================================================================
   CAPE COLOR LOOKUP
   ========================================================================================= */

function getCapeColor(
    value
) {

    /*
     * SPC-style behavior:
     * CAPE below 100 J/kg is transparent.
     */
    if (
        !Number.isFinite(
            value
        ) ||
        value < 100
    ) {

        return null;

    }


    let index =
        CAPE_COLORS.length - 1;


    for (
        let i = 0;
        i <
        CAPE_BOUNDS.length - 1;
        i++
    ) {

        if (
            value >=
                CAPE_BOUNDS[i] &&

            value <
                CAPE_BOUNDS[i + 1]
        ) {

            index =
                i;

            break;

        }

    }


    index =
        Math.max(

            0,

            Math.min(

                CAPE_RGB.length - 1,

                index

            )

        );


    return CAPE_RGB[
        index
    ];

}


function get03kmCapeColor(value) {

    if (!Number.isFinite(value) || value < 10) {
        return null;
    }

    const clipped =
        Math.min(600, Math.max(0, value));

    const index =
        Math.max(
            0,
            Math.min(
                CAPE_03KM_RGB.length - 1,
                Math.floor(clipped / 10)
            )
        );

    return CAPE_03KM_RGB[index];

}


/* =========================================================================================
   DEWPOINT COLOR LOOKUP
   ========================================================================================= */

function getDewpointColor(
    value
) {

    /*
     * The source has occasionally contained obviously invalid/fill-like
     * values. Reject anything outside a physically useful range before
     * clipping to the color table.
     */
    if (
        !Number.isFinite(
            value
        ) ||

        value < -100 ||

        value > 120
    ) {

        return null;

    }


    /*
     * Palette bins:
     *
     * -41 to < -40
     * -40 to < -39
     * ...
     *  89 to < 90
     *
     * Values colder than -41°F use the first valid palette color.
     */
    const clipped =
        Math.max(

            -41,

            Math.min(

                89.999,

                value

            )

        );


    const index =
        Math.max(

            0,

            Math.min(

                DEWPOINT_RGB.length - 1,

                Math.floor(
                    clipped + 41
                )

            )

        );


    return DEWPOINT_RGB[
        index
    ];

}


/* =========================================================================================
   FILLED WIND-SPEED COLOR LOOKUP
   ========================================================================================= */

function getBinnedWindColor(
    value,
    minimum,
    bounds,
    rgbColors
) {

    if (
        !Number.isFinite(value) ||
        value < minimum
    ) {
        return null;
    }

    let index =
        rgbColors.length - 1;

    for (
        let i = 0;
        i < bounds.length - 1;
        i++
    ) {
        if (
            value >= bounds[i] &&
            value < bounds[i + 1]
        ) {
            index = i;
            break;
        }
    }

    index = Math.max(
        0,
        Math.min(
            rgbColors.length - 1,
            index
        )
    );

    return rgbColors[index];
}



function getRhColor(value) {

    if (!Number.isFinite(value)) {
        return null;
    }

    const clipped = Math.max(0, Math.min(100, value));
    const bin = Math.max(0, Math.min(100, Math.floor(clipped)));

    /*
     * BoundaryNorm stretches region indices across the available color
     * indices when ncolors exceeds the number of regions.
     */
    const colorIndex = Math.max(
        0,
        Math.min(
            RH_RGB.length - 1,
            Math.floor(bin * (RH_RGB.length - 1) / 100)
        )
    );

    return RH_RGB[colorIndex];
}


/* =========================================================================================
   FIELD COLOR LOOKUP
   ========================================================================================= */

function getFieldColor(
    field,
    value
) {

    const definition =
        WEATHER_FIELDS[
            field
        ];


    if (!definition) {

        return null;

    }


    if (definition.type === "q_vector_divergence") return getQDivColor(value);
    if (definition.type === "cin") return getCinColor(value);

    if (
        definition.type ===
        "cape"
    ) {

        return getCapeColor(
            value
        );

    }


    if (
        definition.type ===
        "cape_0_3km"
    ) {

        return get03kmCapeColor(
            value
        );

    }


    if (
        definition.type ===
        "wind_midlevel"
    ) {

        return getBinnedWindColor(
            value,
            20,
            MIDLEVEL_WIND_BOUNDS,
            MIDLEVEL_WIND_RGB
        );

    }


    if (
        definition.type ===
        "wind_500"
    ) {

        return getBinnedWindColor(
            value,
            20,
            WIND_500_BOUNDS,
            WIND_500_RGB
        );

    }


    if (
        definition.type ===
        "wind_250"
    ) {

        return getBinnedWindColor(
            value,
            50,
            WIND_250_BOUNDS,
            WIND_250_RGB
        );

    }


    if (
        definition.type ===
        "pwat"
    ) {

        return getBinnedWindColor(
            value,
            0,
            PWAT_BOUNDS,
            PWAT_RGB
        );

    }


    if (
        definition.type ===
        "stp"
    ) {

        return getBinnedWindColor(
            value,
            0,
            STP_BOUNDS,
            STP_RGB
        );

    }


    if (
        definition.type ===
        "scp"
    ) {

        return getBinnedWindColor(
            value,
            0,
            SCP_BOUNDS,
            SCP_RGB
        );

    }


    if (
        definition.type ===
        "temperature"
    ) {

        return getBinnedWindColor(
            value,
            -100,
            TEMPERATURE_BOUNDS,
            TEMPERATURE_RGB
        );

    }


    if (
        definition.type ===
        "pressure_temperature"
    ) {

        return getBinnedWindColor(
            value,
            -50,
            PRESSURE_TEMPERATURE_BOUNDS,
            PRESSURE_TEMPERATURE_RGB
        );

    }


    if (definition.type === "temperature_advection") {
        if (Number.isFinite(value) && value >= -0.5 && value <= 0.5) {
            return { r: 255, g: 255, b: 255 };
        }
        return getBinnedWindColor(value, -16, TEMPERATURE_ADVECTION_BOUNDS, TEMPERATURE_ADVECTION_RGB);
    }


    if (definition.type === "lapse_rate") {
        return getBinnedWindColor(
            value,
            0,
            LAPSE_RATE_BOUNDS,
            LAPSE_RATE_RGB
        );
    }

    if (definition.type === "srh") {
        return getBinnedWindColor(value, 0, SRH_BOUNDS, SRH_RGB);
    }

    if (definition.type === "ehi") {
        return getBinnedWindColor(value, 0, EHI_BOUNDS, EHI_RGB);
    }

    if (definition.type === "petterssen_fgen") {
        if (Number.isFinite(value) && value >= -0.5 && value <= 0.5) return { r: 255, g: 255, b: 255 };
        const rgb = getBinnedWindColor(Math.max(-20, Math.min(20, value)), -20, PETTERSSEN_FGEN_BOUNDS, PETTERSSEN_FGEN_RGB);
        return rgb ? { r: rgb[0], g: rgb[1], b: rgb[2] } : null;
    }
    if (definition.type === "relative_vorticity") {
        return getBinnedWindColor(
            value,
            -40,
            RELATIVE_VORTICITY_BOUNDS,
            RELATIVE_VORTICITY_RGB
        );
    }

    if (definition.type === "surface_deformation") {
        return getBinnedWindColor(
            value,
            8,
            SFC_DEFORMATION_BOUNDS,
            SFC_DEFORMATION_RGB
        );
    }


    if (
        definition.type ===
        "dewpoint"
    ) {

        return getDewpointColor(
            value
        );

    }


    if (
        definition.type ===
        "thetae"
    ) {

        return getBinnedWindColor(
            value,
            239,
            THETAE_BOUNDS,
            THETAE_RGB
        );

    }


    if (
        definition.type ===
        "rh"
    ) {

        return getRhColor(
            value
        );

    }


    return null;

}


/* =========================================================================================
   FAST FLAT-MAP NUMERICAL SAMPLING (DISPLAY ONLY)

   The normal map is Web Mercator, bearing=0, pitch=0. MapLibre.unproject()
   for every raster pixel is unnecessarily expensive. Convert screen pixels
   directly to the existing binary-tile coordinate system instead. For any
   rotated/pitched view, fall back to the original MapLibre-based sampler.

   Encoding, nodata treatment, color decisions, data zooms and tiles are NOT
   changed. The fast sampler handles wrapped tile-X and cross-tile edges.
   ========================================================================================= */
function getFlatMapTileCoordinates(width, height, dataZoom) {
    if (Math.abs(map.getBearing()) > 0.000001 || Math.abs(map.getPitch()) > 0.000001) return null;
    const mapCanvas = map.getCanvas();
    if (Math.abs(mapCanvas.clientWidth - width) > 2 ||
        Math.abs(mapCanvas.clientHeight - height) > 2) return null;
    const center = map.getCenter();
    const step = Math.pow(2, dataZoom - map.getZoom());
    const startX = lonToTileX(center.lng, dataZoom) * TILE_SIZE - 0.5 * width * step;
    const startY = latToTileY(center.lat, dataZoom) * TILE_SIZE - 0.5 * height * step;
    // Confirm the fast camera mapping against MapLibre once per render.
    // This also protects future site changes (nonstandard camera projections).
    const checkX = width * 0.73;
    const checkY = height * 0.37;
    const checkLL = map.unproject([checkX, checkY]);
    const referenceX = lonToTileX(checkLL.lng, dataZoom) * TILE_SIZE;
    const referenceY = latToTileY(checkLL.lat, dataZoom) * TILE_SIZE;
    const predictedX = startX + checkX * step;
    const predictedY = startY + checkY * step;
    const wrap = TILE_SIZE * (2 ** dataZoom);
    const dx = Math.abs(((referenceX - predictedX + wrap / 2) % wrap + wrap) % wrap - wrap / 2);
    if (dx > 0.05 || Math.abs(referenceY - predictedY) > 0.05) return null;
    return { startX, startY, step };
}

function sampleScalarGlobalPixelsFast(field, z, gx, gy, encoding, contour = false) {
    const worldPixels = TILE_SIZE * (2 ** z);
    const iy = Math.floor(gy);
    if (iy < 0 || iy + 1 >= worldPixels) return null;
    const rawX = Math.floor(gx);
    const ix = ((rawX % worldPixels) + worldPixels) % worldPixels;
    const tx = Math.floor(ix / TILE_SIZE);
    const ty = Math.floor(iy / TILE_SIZE);
    const px = ix - tx * TILE_SIZE;
    const py = iy - ty * TILE_SIZE;
    const fx = gx - rawX;
    const fy = gy - iy;
    const tile = contour ? getCachedContourTile(field, z, tx, ty)
                         : getCachedScalarTile(field, z, tx, ty);
    if (!tile) return null;

    let a, b, c, d;
    if (px < TILE_SIZE - 1 && py < TILE_SIZE - 1) {
        const i = py * TILE_SIZE + px;
        a = tile[i]; b = tile[i + 1];
        c = tile[i + TILE_SIZE]; d = tile[i + TILE_SIZE + 1];
    } else {
        // Crossing a tile boundary is rare; use the original correct sampler.
        // It handles both x wrapping and missing neighbor tiles.
        const a0 = getRawScalarPixel(field, z, rawX, iy, contour);
        const b0 = getRawScalarPixel(field, z, rawX + 1, iy, contour);
        const c0 = getRawScalarPixel(field, z, rawX, iy + 1, contour);
        const d0 = getRawScalarPixel(field, z, rawX + 1, iy + 1, contour);
        if (a0 === null || b0 === null || c0 === null || d0 === null) return null;
        return ((a0 * (1 - fx) + b0 * fx) * (1 - fy)) +
               ((c0 * (1 - fx) + d0 * fx) * fy);
    }

    if (a === encoding.nodata || b === encoding.nodata ||
        c === encoding.nodata || d === encoding.nodata ||
        a === SCALAR_NODATA || b === SCALAR_NODATA ||
        c === SCALAR_NODATA || d === SCALAR_NODATA) return null;
    // Interpolation and affine decoding commute; numerically equivalent to
    // the original per-neighbor decode (within floating-point rounding).
    const top = a * (1 - fx) + b * fx;
    const bottom = c * (1 - fx) + d * fx;
    return (top * (1 - fy) + bottom * fy) * encoding.scale + encoding.offset;
}

/* =========================================================================================
   WEATHER RENDERER
   ========================================================================================= */

async function renderWeather() {
    const perfStart = __MP_PARAMS.get("perf") === "1" ? performance.now() : 0;

    const generation =
        ++scalarRenderGeneration;


    prepareContext(

        weatherCanvas,

        weatherCtx

    );


    weatherCanvas.style.transform =
        "none";


    /*
     * "None" means no filled weather field.
     *
     * Independent overlays such as MSLP and wind barbs are unaffected.
     */
    if (
        !activeField ||
        activeField ===
            "none"
    ) {

        return;

    }


    if (
        !WEATHER_FIELDS[
            activeField
        ]
    ) {

        return;

    }


    const z =
        getDataZoom();


    await preloadScalarTiles(

        activeField,

        z

    );

    const tilesReadyAt = perfStart ? performance.now() : 0;


    if (
        generation !==
        scalarRenderGeneration
    ) {

        return;

    }


    const rect =
        mapWrapper.getBoundingClientRect();


    const width =
        Math.max(

            1,

            Math.round(
                rect.width
            )

        );


    const height =
        Math.max(

            1,

            Math.round(
                rect.height
            )

        );


    /*
     * Keep this at 1.0.
     *
     * Earlier versions used a lower render resolution and enlarged the
     * result, which made the fields look blurry. We now calculate every
     * CSS map pixel while retaining bilinear numerical interpolation.
     */
    const renderScale =
        1.0;


    const renderWidth =
        Math.max(

            1,

            Math.round(
                width *
                renderScale
            )

        );


    const renderHeight =
        Math.max(

            1,

            Math.round(
                height *
                renderScale
            )

        );


    const offscreen =
        document.createElement(
            "canvas"
        );


    offscreen.width =
        renderWidth;


    offscreen.height =
        renderHeight;


    const offscreenCtx =
        offscreen.getContext(
            "2d"
        );


    const image =
        offscreenCtx.createImageData(

            renderWidth,

            renderHeight

        );


    const pixels =
        image.data;


    const fastMapping = getFlatMapTileCoordinates(width, height, z);
    const fastEncoding = getEncoding(fieldMetadata[activeField]);

    let pixelIndex =
        0;


    for (
        let y = 0;
        y < renderHeight;
        y++
    ) {

        const screenY =
            (
                y + 0.5
            ) /
            renderScale;


        for (
            let x = 0;
            x < renderWidth;
            x++
        ) {

            const screenX =
                (
                    x + 0.5
                ) /
                renderScale;


            const value = fastMapping
                ? sampleScalarGlobalPixelsFast(
                    activeField, z,
                    fastMapping.startX + screenX * fastMapping.step,
                    fastMapping.startY + screenY * fastMapping.step,
                    fastEncoding, false)
                : (() => {
                    const ll = map.unproject([screenX, screenY]);
                    return sampleScalar(activeField, ll.lng, ll.lat, z, false);
                })();


            const color =
                getFieldColor(

                    activeField,

                    value

                );


            if (color) {

                pixels[
                    pixelIndex
                ] =
                    color.r;


                pixels[
                    pixelIndex + 1
                ] =
                    color.g;


                pixels[
                    pixelIndex + 2
                ] =
                    color.b;


                /*
                 * Slight transparency keeps state/county geography
                 * visually clean while preserving the field colors.
                 */
                pixels[
                    pixelIndex + 3
                ] =
                    235;

            }
            else {

                pixels[
                    pixelIndex
                ] =
                    0;


                pixels[
                    pixelIndex + 1
                ] =
                    0;


                pixels[
                    pixelIndex + 2
                ] =
                    0;


                pixels[
                    pixelIndex + 3
                ] =
                    0;

            }


            pixelIndex +=
                4;

        }

    }


    if (
        generation !==
        scalarRenderGeneration
    ) {

        return;

    }


    offscreenCtx.putImageData(

        image,

        0,

        0

    );


    const dpr =
        window.devicePixelRatio || 1;


    weatherCtx.setTransform(

        dpr,

        0,

        0,

        dpr,

        0,

        0

    );


    weatherCtx.imageSmoothingEnabled =
        true;


    weatherCtx.clearRect(

        0,

        0,

        width,

        height

    );


    weatherCtx.drawImage(

        offscreen,

        0,

        0,

        width,

        height

    );

    if (perfStart) {
        console.info(`[SPCOA performance] ${activeField}: tiles=${(tilesReadyAt - perfStart).toFixed(0)}ms, ` +
            `fill=${(performance.now() - tilesReadyAt).toFixed(0)}ms, ` +
            `fast=${Boolean(fastMapping)}, decodedCache=${(numericalCacheBytes / 1048576).toFixed(1)}MiB`);
    }

}
/* =========================================================================================
   WIND BARB SPACING
   ========================================================================================= */

function getBarbSpacing() {

    const zoom =
        map.getZoom();


    if (
        zoom < 4.5
    ) {

        return 60;

    }


    if (
        zoom < 5.5
    ) {

        return 54;

    }


    if (
        zoom < 6.5
    ) {

        return 48;

    }


    if (
        zoom < 7.5
    ) {

        return 42;

    }


    return 38;

}


/* =========================================================================================
   DRAW WIND BARB
   ========================================================================================= */

function drawWindBarb(
    ctx,
    x,
    y,
    u,
    v,
    color = "#000000"
) {

    const speed =
        Math.hypot(
            u,
            v
        );


    ctx.save();


    ctx.strokeStyle =
        color;


    ctx.fillStyle =
        color;


    ctx.lineWidth =
        1.2;


    ctx.lineCap =
        "round";


    ctx.lineJoin =
        "round";


    /*
     * Calm wind.
     */
    if (
        speed < 2.5
    ) {

        ctx.beginPath();


        ctx.arc(

            x,

            y,

            3,

            0,

            Math.PI * 2

        );


        ctx.stroke();


        ctx.restore();


        return;

    }


    /*
     * Meteorological wind barbs point toward the direction
     * FROM which the wind is coming.
     *
     * For map-screen coordinates:
     *
     *   screen x increases eastward
     *   screen y increases southward
     *
     * The staff therefore uses:
     *
     *   shaftX = -u / speed
     *   shaftY =  v / speed
     */
    const shaftX =
        -u /
        speed;


    const shaftY =
        v /
        speed;


    const normalX =
        -shaftY;


    const normalY =
        shaftX;


    const staffLength =
        23;


    const tipX =
        x +
        shaftX *
        staffLength;


    const tipY =
        y +
        shaftY *
        staffLength;


    /*
     * Main staff.
     */
    ctx.beginPath();


    ctx.moveTo(
        x,
        y
    );


    ctx.lineTo(
        tipX,
        tipY
    );


    ctx.stroke();


    /*
     * Round to nearest 5 kt for standard barb notation.
     */
    let remaining =
        Math.round(
            speed /
            5
        ) *
        5;


    let position =
        staffLength;


    const featherLength =
        8;


    const featherSpacing =
        4;


    /*
     * 50-kt flags.
     */
    while (
        remaining >= 50
    ) {

        const baseX =
            x +
            shaftX *
            position;


        const baseY =
            y +
            shaftY *
            position;


        const nextPosition =
            position -
            featherSpacing;


        const nextX =
            x +
            shaftX *
            nextPosition;


        const nextY =
            y +
            shaftY *
            nextPosition;


        const flagX =
            nextX +
            normalX *
            featherLength;


        const flagY =
            nextY +
            normalY *
            featherLength;


        ctx.beginPath();


        ctx.moveTo(
            baseX,
            baseY
        );


        ctx.lineTo(
            flagX,
            flagY
        );


        ctx.lineTo(
            nextX,
            nextY
        );


        ctx.closePath();


        ctx.fill();


        remaining -=
            50;


        position -=
            featherSpacing +
            1;

    }


    /*
     * 10-kt full barbs.
     */
    while (
        remaining >= 10
    ) {

        const baseX =
            x +
            shaftX *
            position;


        const baseY =
            y +
            shaftY *
            position;


        ctx.beginPath();


        ctx.moveTo(
            baseX,
            baseY
        );


        ctx.lineTo(

            baseX +
            normalX *
            featherLength,

            baseY +
            normalY *
            featherLength

        );


        ctx.stroke();


        remaining -=
            10;


        position -=
            featherSpacing;

    }


    /*
     * 5-kt half barb.
     */
    if (
        remaining >= 5
    ) {

        const baseX =
            x +
            shaftX *
            position;


        const baseY =
            y +
            shaftY *
            position;


        ctx.beginPath();


        ctx.moveTo(
            baseX,
            baseY
        );


        ctx.lineTo(

            baseX +
            normalX *
            featherLength *
            0.5,

            baseY +
            normalY *
            featherLength *
            0.5

        );


        ctx.stroke();

    }


    ctx.restore();

}


/* =========================================================================================
   DRAW AXIS OF DILATATION
   ========================================================================================= */
function drawAxisOfDilatation(ctx, x, y, axisU, axisV, color = "#1f5fbf") {
    const magnitude = Math.hypot(axisU, axisV);
    if (!Number.isFinite(magnitude) || magnitude < 1.0e-6) return;

    // Backend magnitude is resultant deformation in 10^-5 s^-1; direction is the
    // axis of dilatation. Canvas y increases downward, so projected y is reversed.
    const dx = axisU / magnitude;
    const dy = -axisV / magnitude;

    // SPC-style convention: segment length increases with resultant deformation.
    // Keep weak axes visible but cap extreme values so isolated maxima cannot dominate.
    const deformation = Math.min(Math.max(magnitude, 0), 32);
    const halfLength = Math.min(58, 5.0 + 1.65 * deformation); // deliberately exaggerated, SPC-inspired

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3.0;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - dx * halfLength, y - dy * halfLength);
    ctx.lineTo(x + dx * halfLength, y + dy * halfLength);
    ctx.stroke();
    ctx.restore();
}

/* =========================================================================================
   GEOSTROPHIC Q-VECTOR ARROWS (NOT WIND BARBS)
   ========================================================================================= */
function drawQVectorArrow(ctx, x, y, qx, qy, color = "#000000") {
    const magnitude = Math.hypot(qx, qy);
    if (!Number.isFinite(magnitude) || magnitude < 1e-20) return;
    // Q-vectors have extremely small SI magnitudes. Use a logarithmic, capped
    // display scale so weaker vectors remain visible without enormous arrows.
    const length = Math.max(9, Math.min(35, 12 + 7 * Math.log10(1 + magnitude / 1e-13)));
    const dx = qx / magnitude;
    const dy = -qy / magnitude; // screen Y points south
    const ex = x + dx * length;
    const ey = y + dy * length;
    const head = Math.max(5, Math.min(9, length * 0.32));
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - dx * head - dy * head * 0.45, ey - dy * head + dx * head * 0.45);
    ctx.lineTo(ex - dx * head + dy * head * 0.45, ey - dy * head - dx * head * 0.45);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

/* =========================================================================================
   RENDER ONE VECTOR FIELD
   ========================================================================================= */

async function renderVectorField(
    field,
    generation
) {

    const z =
        getDataZoom();


    await preloadVectorTiles(

        field,

        z

    );


    if (
        generation !==
        vectorRenderGeneration
    ) {

        return;

    }


    const rect =
        mapWrapper.getBoundingClientRect();


    const width =
        rect.width;


    const height =
        rect.height;


    const spacing =
        getBarbSpacing();


    /*
     * IMPORTANT: every wind product uses this exact same screen-space grid.
     * Switching between surface wind and any SR-wind layer therefore keeps
     * every barb anchored at the same map sampling location.
     */
    for (
        let y =
            spacing / 2;

        y <
            height;

        y +=
            spacing
    ) {

        for (
            let x =
                spacing / 2;

            x <
                width;

            x +=
                spacing
        ) {

            const lngLat =
                map.unproject([

                    x,

                    y

                ]);


            const vector =
                sampleVector(

                    field,

                    lngLat.lng,

                    lngLat.lat,

                    z

                );


            if (!vector) {

                continue;

            }


            if (
                !Number.isFinite(
                    vector.u
                ) ||

                !Number.isFinite(
                    vector.v
                )
            ) {

                continue;

            }


            const vectorDefinition = VECTOR_FIELDS[field] || {};

            if (vectorDefinition.renderType === "axis_segments") {
                drawAxisOfDilatation(
                    vectorCtx,
                    x,
                    y,
                    vector.u,
                    vector.v,
                    vectorColors[field] || vectorDefinition.defaultColor || "#1f5fbf"
                );
            } else if (vectorDefinition.renderType === "arrows") {
                drawQVectorArrow(
                    vectorCtx, x, y, vector.u, vector.v,
                    vectorColors[field] || vectorDefinition.defaultColor || "#000000"
                );
            } else {
                drawWindBarb(
                    vectorCtx,
                    x,
                    y,
                    vector.u,
                    vector.v,
                    vectorColors[field] || "#000000"
                );
            }

        }

    }

}


/* =========================================================================================
   VECTOR RENDERER
   ========================================================================================= */

async function renderVectors() {

    const generation =
        ++vectorRenderGeneration;


    prepareContext(

        vectorCanvas,

        vectorCtx

    );


    vectorCanvas.style.transform =
        "none";


    const jobs = [];


    for (const config of VECTOR_OVERLAY_CONFIG) {

        if (!activeOverlays[config.stateKey]) {
            continue;
        }

        jobs.push(
            renderVectorField(
                config.field,
                generation
            )
        );
    }


    await Promise.all(
        jobs
    );

}



/* =========================================================================================
   MARCHING-SQUARES INTERPOLATION
   ========================================================================================= */

function interpolateContourPoint(
    x1,
    y1,
    value1,
    x2,
    y2,
    value2,
    level
) {

    let fraction =
        0.5;


    if (
        Number.isFinite(
            value1
        ) &&

        Number.isFinite(
            value2
        ) &&

        value2 !==
            value1
    ) {

        fraction =
            (
                level -
                value1
            ) /
            (
                value2 -
                value1
            );

    }


    fraction =
        Math.max(

            0,

            Math.min(

                1,

                fraction

            )

        );


    return {

        x:
            x1 +
            (
                x2 -
                x1
            ) *
            fraction,

        y:
            y1 +
            (
                y2 -
                y1
            ) *
            fraction

    };

}


/* =========================================================================================
   OPTIONAL CONTOUR-GEOMETRY SMOOTHING

   Used only by contour definitions with smoothGeometry: true.
   The numerical field is NOT changed here.  These helpers first join the
   individual marching-squares segments into continuous polylines and then
   remove redundant close vertices and apply Catmull-Rom interpolation to make the rendered line visually smoother.
   ========================================================================================= */

function contourPointKey(point, precision = 1000) {

    return (
        Math.round(point.x * precision) +
        ":" +
        Math.round(point.y * precision)
    );

}


function stitchContourSegments(segments) {

    if (!segments || segments.length === 0) {
        return [];
    }

    const endpointMap = new Map();

    function addEndpoint(key, segmentIndex, endpointIndex) {

        if (!endpointMap.has(key)) {
            endpointMap.set(key, []);
        }

        endpointMap.get(key).push({
            segmentIndex,
            endpointIndex
        });

    }

    for (let i = 0; i < segments.length; i++) {

        addEndpoint(
            contourPointKey(segments[i][0]),
            i,
            0
        );

        addEndpoint(
            contourPointKey(segments[i][1]),
            i,
            1
        );

    }

    const used = new Uint8Array(segments.length);
    const polylines = [];

    function extendLine(line, atStart) {

        while (true) {

            const endpoint =
                atStart
                    ? line[0]
                    : line[line.length - 1];

            const matches =
                endpointMap.get(
                    contourPointKey(endpoint)
                ) || [];

            let nextMatch = null;

            for (const match of matches) {

                if (!used[match.segmentIndex]) {
                    nextMatch = match;
                    break;
                }

            }

            if (!nextMatch) {
                break;
            }

            used[nextMatch.segmentIndex] = 1;

            const segment =
                segments[nextMatch.segmentIndex];

            const otherPoint =
                nextMatch.endpointIndex === 0
                    ? segment[1]
                    : segment[0];

            if (atStart) {
                line.unshift(otherPoint);
            }
            else {
                line.push(otherPoint);
            }

        }

    }

    /*
     * Begin open contours at endpoints that occur only once.  This avoids
     * accidentally starting an open contour in its middle.
     */
    for (let i = 0; i < segments.length; i++) {

        if (used[i]) {
            continue;
        }

        const keyA = contourPointKey(segments[i][0]);
        const keyB = contourPointKey(segments[i][1]);

        const degreeA = (endpointMap.get(keyA) || []).length;
        const degreeB = (endpointMap.get(keyB) || []).length;

        if (degreeA === 2 && degreeB === 2) {
            continue;
        }

        used[i] = 1;

        const line = [
            segments[i][0],
            segments[i][1]
        ];

        extendLine(line, false);
        extendLine(line, true);

        polylines.push(line);

    }

    /*
     * Anything left is normally a closed contour.  Stitch those loops now.
     */
    for (let i = 0; i < segments.length; i++) {

        if (used[i]) {
            continue;
        }

        used[i] = 1;

        const line = [
            segments[i][0],
            segments[i][1]
        ];

        extendLine(line, false);
        extendLine(line, true);

        polylines.push(line);

    }

    return polylines;

}


function simplifyContourPolyline(points, minimumDistance = 2.5) {

    if (!points || points.length < 3) {
        return points;
    }

    const simplified = [points[0]];
    let lastKept = points[0];

    for (let i = 1; i < points.length - 1; i++) {

        const point = points[i];
        const distance = Math.hypot(
            point.x - lastKept.x,
            point.y - lastKept.y
        );

        if (distance >= minimumDistance) {
            simplified.push(point);
            lastKept = point;
        }

    }

    simplified.push(points[points.length - 1]);

    return simplified;

}


function smoothContourPolyline(points, subdivisions = 4) {

    if (!points || points.length < 4) {
        return points;
    }

    const first = points[0];
    const last = points[points.length - 1];

    const closed =
        Math.hypot(
            first.x - last.x,
            first.y - last.y
        ) < 0.01;

    let working = points.map(point => ({
        x: point.x,
        y: point.y
    }));

    if (closed) {
        working = working.slice(0, -1);
    }

    /*
     * Remove very closely spaced marching-squares vertices before fitting
     * the spline.  This suppresses the tiny grid-scale wiggles without
     * changing the underlying meteorological field.
     */
    if (closed) {
        const temporarilyClosed = working.concat([working[0]]);
        working = simplifyContourPolyline(temporarilyClosed, 2.5);
        working = working.slice(0, -1);
    }
    else {
        working = simplifyContourPolyline(working, 2.5);
    }

    if (working.length < 4) {
        const fallback = working.slice();
        if (closed && fallback.length > 0) {
            fallback.push({
                x: fallback[0].x,
                y: fallback[0].y
            });
        }
        return fallback;
    }

    const result = [];
    const steps = Math.max(2, Math.round(subdivisions));

    function catmullRom(p0, p1, p2, p3, t) {

        const t2 = t * t;
        const t3 = t2 * t;

        return {
            x: 0.5 * (
                (2 * p1.x) +
                (-p0.x + p2.x) * t +
                (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
                (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
            ),
            y: 0.5 * (
                (2 * p1.y) +
                (-p0.y + p2.y) * t +
                (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
                (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
            )
        };

    }

    if (closed) {

        const n = working.length;

        for (let i = 0; i < n; i++) {

            const p0 = working[(i - 1 + n) % n];
            const p1 = working[i];
            const p2 = working[(i + 1) % n];
            const p3 = working[(i + 2) % n];

            for (let j = 0; j < steps; j++) {
                result.push(
                    catmullRom(
                        p0,
                        p1,
                        p2,
                        p3,
                        j / steps
                    )
                );
            }

        }

        if (result.length > 0) {
            result.push({
                x: result[0].x,
                y: result[0].y
            });
        }

    }
    else {

        for (let i = 0; i < working.length - 1; i++) {

            const p0 = working[Math.max(0, i - 1)];
            const p1 = working[i];
            const p2 = working[i + 1];
            const p3 = working[Math.min(working.length - 1, i + 2)];

            for (let j = 0; j < steps; j++) {
                result.push(
                    catmullRom(
                        p0,
                        p1,
                        p2,
                        p3,
                        j / steps
                    )
                );
            }

        }

        result.push({
            x: working[working.length - 1].x,
            y: working[working.length - 1].y
        });

    }

    return result;

}


/* =========================================================================================
   MARCHING-SQUARES CELL
   ========================================================================================= */

function getMarchingSegments(
    x,
    y,
    step,
    valueTopLeft,
    valueTopRight,
    valueBottomRight,
    valueBottomLeft,
    level
) {

    /*
     * A missing corner invalidates this cell.
     */
    if (
        !Number.isFinite(
            valueTopLeft
        ) ||

        !Number.isFinite(
            valueTopRight
        ) ||

        !Number.isFinite(
            valueBottomRight
        ) ||

        !Number.isFinite(
            valueBottomLeft
        )
    ) {

        return [];

    }


    const top =
        interpolateContourPoint(

            x,

            y,

            valueTopLeft,

            x + step,

            y,

            valueTopRight,

            level

        );


    const right =
        interpolateContourPoint(

            x + step,

            y,

            valueTopRight,

            x + step,

            y + step,

            valueBottomRight,

            level

        );


    const bottom =
        interpolateContourPoint(

            x,

            y + step,

            valueBottomLeft,

            x + step,

            y + step,

            valueBottomRight,

            level

        );


    const left =
        interpolateContourPoint(

            x,

            y,

            valueTopLeft,

            x,

            y + step,

            valueBottomLeft,

            level

        );


    /*
     * Standard marching-squares bit mask:
     *
     *   TL = 8
     *   TR = 4
     *   BR = 2
     *   BL = 1
     */
    const mask =
        (
            valueTopLeft >=
                level
                ? 8
                : 0
        ) |

        (
            valueTopRight >=
                level
                ? 4
                : 0
        ) |

        (
            valueBottomRight >=
                level
                ? 2
                : 0
        ) |

        (
            valueBottomLeft >=
                level
                ? 1
                : 0
        );


    switch (mask) {

        case 0:

        case 15:

            return [];


        case 1:

        case 14:

            return [
                [
                    left,
                    bottom
                ]
            ];


        case 2:

        case 13:

            return [
                [
                    bottom,
                    right
                ]
            ];


        case 3:

        case 12:

            return [
                [
                    left,
                    right
                ]
            ];


        case 4:

        case 11:

            return [
                [
                    top,
                    right
                ]
            ];


        case 6:

        case 9:

            return [
                [
                    top,
                    bottom
                ]
            ];


        case 7:

        case 8:

            return [
                [
                    left,
                    top
                ]
            ];


        /*
         * Ambiguous saddle-point case.
         */
        case 5: {

            const center =
                (
                    valueTopLeft +
                    valueTopRight +
                    valueBottomRight +
                    valueBottomLeft
                ) /
                4;


            if (
                center >=
                level
            ) {

                return [

                    [
                        top,
                        left
                    ],

                    [
                        right,
                        bottom
                    ]

                ];

            }


            return [

                [
                    top,
                    right
                ],

                [
                    left,
                    bottom
                ]

            ];

        }


        /*
         * Other ambiguous saddle-point case.
         */
        case 10: {

            const center =
                (
                    valueTopLeft +
                    valueTopRight +
                    valueBottomRight +
                    valueBottomLeft
                ) /
                4;


            if (
                center >=
                level
            ) {

                return [

                    [
                        top,
                        right
                    ],

                    [
                        left,
                        bottom
                    ]

                ];

            }


            return [

                [
                    top,
                    left
                ],

                [
                    right,
                    bottom
                ]

            ];

        }


        default:

            return [];

    }

}


/* =========================================================================================
   MSLP LABEL
   ========================================================================================= */

function drawMslpLabel(
    ctx,
    x,
    y,
    angle,
    level,
    color = "#000000",
    haloColor = "rgba(255,255,255,0.88)"
) {

    /*
     * Keep text from becoming upside down when the local contour
     * direction points leftward.
     */
    if (
        angle >
        Math.PI / 2
    ) {

        angle -=
            Math.PI;

    }


    if (
        angle <
        -Math.PI / 2
    ) {

        angle +=
            Math.PI;

    }


    ctx.save();


    ctx.translate(
        x,
        y
    );


    ctx.rotate(
        angle
    );


    ctx.font =
        "bold 11px Arial, Helvetica, sans-serif";


    ctx.textAlign =
        "center";


    ctx.textBaseline =
        "middle";


    /*
     * Thin white halo.
     *
     * This is intentionally much lighter than the earlier version so
     * the labels remain readable without looking overly bold.
     */
    ctx.lineWidth =
        1.5;


    ctx.lineJoin =
        "round";


    ctx.strokeStyle =
        haloColor;


    ctx.strokeText(

        String(
            Math.round(
                level
            )
        ),

        0,

        0

    );


    ctx.fillStyle =
        color;


    ctx.fillText(

        String(
            Math.round(
                level
            )
        ),

        0,

        0

    );


    ctx.restore();

}


/* =========================================================================================
   DISTANCE BETWEEN LABELS
   ========================================================================================= */

function labelTooClose(
    x,
    y,
    existingLabels,
    minimumDistance
) {

    for (
        const label
        of
        existingLabels
    ) {

        const dx =
            x -
            label.x;


        const dy =
            y -
            label.y;


        if (
            Math.hypot(
                dx,
                dy
            ) <
            minimumDistance
        ) {

            return true;

        }

    }


    return false;

}


/* =========================================================================================
   MSLP CONTOUR RENDERER
   ========================================================================================= */

function getContourCapeColor(value) {

    if (!Number.isFinite(value)) {
        return "#000000";
    }

    let index = 0;

    for (
        let i = 0;
        i < CAPE_BOUNDS.length;
        i++
    ) {

        if (value >= CAPE_BOUNDS[i]) {
            index = i;
        }
        else {
            break;
        }

    }

    index = Math.max(
        0,
        Math.min(
            CAPE_COLORS.length - 1,
            index
        )
    );

    return CAPE_COLORS[index];

}


function getDcapeColor(value) {

    if (!Number.isFinite(value)) {
        return DCAPE_COLORS[0];
    }

    let index = DCAPE_BOUNDS.length - 1;

    for (let i = 0; i < DCAPE_BOUNDS.length - 1; i++) {
        if (value >= DCAPE_BOUNDS[i] && value < DCAPE_BOUNDS[i + 1]) {
            index = i;
            break;
        }
    }

    if (value < DCAPE_BOUNDS[0]) {
        index = 0;
    }

    index = Math.max(0, Math.min(DCAPE_COLORS.length - 1, index));

    return DCAPE_COLORS[index];

}


function getWcdColor(value) {

    if (!Number.isFinite(value)) {
        return WCD_COLORS[0];
    }

    let index = WCD_BOUNDS.length - 2;

    for (let i = 0; i < WCD_BOUNDS.length - 1; i++) {
        if (value >= WCD_BOUNDS[i] && value < WCD_BOUNDS[i + 1]) {
            index = i;
            break;
        }
    }

    if (value < WCD_BOUNDS[0]) {
        index = 0;
    }

    index = Math.max(0, Math.min(WCD_COLORS.length - 1, index));

    return WCD_COLORS[index];
}


function getDiscreteContourColor(
    value,
    bounds,
    colors
) {

    if (!Number.isFinite(value)) {
        return colors[0];
    }

    let index = 0;

    for (let i = 0; i < bounds.length; i++) {
        if (value >= bounds[i]) {
            index = i;
        }
        else {
            break;
        }
    }

    index = Math.max(
        0,
        Math.min(colors.length - 1, index)
    );

    return colors[index];
}


function getLclColor(value) {
    return getDiscreteContourColor(
        value,
        LCL_BOUNDS,
        LCL_COLORS
    );
}



function smoothContourGrid(grid, columns, rows, sigma = 2.0) {

    /*
     * True separable Gaussian smoothing of the sampled screen-space grid.
     * This is intentionally performed BEFORE marching squares so the contour
     * generator receives a smooth scalar field instead of trying to repair
     * jagged contour geometry afterward.
     */
    if (!Number.isFinite(sigma) || sigma <= 0) {
        return new Float32Array(grid);
    }

    const radius = Math.max(1, Math.ceil(sigma * 3));
    const kernel = new Float64Array(radius * 2 + 1);
    let kernelSum = 0;

    for (let offset = -radius; offset <= radius; offset++) {
        const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
        kernel[offset + radius] = weight;
        kernelSum += weight;
    }

    for (let i = 0; i < kernel.length; i++) {
        kernel[i] /= kernelSum;
    }

    const source = new Float32Array(grid);
    const horizontal = new Float32Array(source.length);
    const output = new Float32Array(source.length);
    horizontal.fill(NaN);
    output.fill(NaN);

    // Horizontal pass. Renormalize around NaNs and map edges.
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            let weightedSum = 0;
            let totalWeight = 0;

            for (let offset = -radius; offset <= radius; offset++) {
                const sampleColumn = column + offset;
                if (sampleColumn < 0 || sampleColumn >= columns) continue;

                const value = source[row * columns + sampleColumn];
                if (!Number.isFinite(value)) continue;

                const weight = kernel[offset + radius];
                weightedSum += value * weight;
                totalWeight += weight;
            }

            if (totalWeight > 0) {
                horizontal[row * columns + column] = weightedSum / totalWeight;
            }
        }
    }

    // Vertical pass. Renormalize around NaNs and map edges.
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            let weightedSum = 0;
            let totalWeight = 0;

            for (let offset = -radius; offset <= radius; offset++) {
                const sampleRow = row + offset;
                if (sampleRow < 0 || sampleRow >= rows) continue;

                const value = horizontal[sampleRow * columns + column];
                if (!Number.isFinite(value)) continue;

                const weight = kernel[offset + radius];
                weightedSum += value * weight;
                totalWeight += weight;
            }

            if (totalWeight > 0) {
                output[row * columns + column] = weightedSum / totalWeight;
            }
        }
    }

    return output;
}


/* =========================================================================================
   GENERIC NUMERICAL CONTOUR FIELD RENDERER
   ========================================================================================= */

async function renderContourField(
    field,
    generation,
    acceptedLabels
) {

    const metadata =
        contourMetadata[field];

    if (!metadata) {

        console.warn(
            `${field} contour metadata is not available.`
        );

        return;

    }

    const definition =
        CONTOUR_FIELDS[field] || {};

    const z =
        getDataZoom();

    await preloadContourTiles(
        field,
        z
    );

    if (
        generation !==
        contourRenderGeneration
    ) {
        return;
    }

    const rect =
        mapWrapper.getBoundingClientRect();

    const width =
        Math.max(
            1,
            Math.round(rect.width)
        );

    const height =
        Math.max(
            1,
            Math.round(rect.height)
        );

    /*
     * Keep the existing 4-pixel contour grid for MSLP and pressure-level
     * heights. Divergence and frontogenesis use a full 1-pixel grid so
     * marching squares has the maximum available screen-space sampling
     * resolution when zoomed in. The existing Gaussian smoothing below is
     * preserved for all fields with smoothGeometry: true.
     */
    const useHighResolutionContourGrid =
        field.startsWith("divergence_") ||
        field.startsWith("frontogenesis_");

    const step =
        useHighResolutionContourGrid
            ? 1
            : 4;

    const columns =
        Math.ceil(width / step) + 1;

    const rows =
        Math.ceil(height / step) + 1;

    const values =
        new Float32Array(
            columns * rows
        );

    values.fill(NaN);

    let minimumValue = Infinity;
    let maximumValue = -Infinity;

    for (
        let row = 0;
        row < rows;
        row++
    ) {

        const screenY =
            Math.min(
                height,
                row * step
            );

        for (
            let column = 0;
            column < columns;
            column++
        ) {

            const screenX =
                Math.min(
                    width,
                    column * step
                );

            const lngLat =
                map.unproject([
                    screenX,
                    screenY
                ]);

            const value =
                sampleScalar(
                    field,
                    lngLat.lng,
                    lngLat.lat,
                    z,
                    true
                );

            if (
                value === null ||
                !Number.isFinite(value)
            ) {
                continue;
            }

            values[
                row * columns + column
            ] = value;

            minimumValue =
                Math.min(
                    minimumValue,
                    value
                );

            maximumValue =
                Math.max(
                    maximumValue,
                    value
                );

        }

    }

    if (
        !Number.isFinite(minimumValue) ||
        !Number.isFinite(maximumValue)
    ) {
        return;
    }

    /*
     * Smooth only MSLP, pressure-level heights, divergence, and
     * frontogenesis before marching squares. A screen-grid sigma of 2.0
     * is the initial test value. Existing DCAPE/WCD light smoothing remains.
     */
    const useGaussianContourSmoothing =
        definition.smoothGeometry === true;

    const contourValues =
        useGaussianContourSmoothing
            ? smoothContourGrid(values, columns, rows, 2.0)
            : (
                (field === "dcape" || field === "warm_cloud_depth")
                    ? smoothContourGrid(values, columns, rows, 1.0)
                    : values
            );

    const interval =
        Number(
            metadata.display &&
            metadata.display.interval
        ) ||
        Number(definition.interval) ||
        2;

    const configuredMinimum =
        field === "dcape"
            ? 200
            : (
                metadata.display &&
                metadata.display.minimum !== undefined &&
                metadata.display.minimum !== null
                    ? Number(metadata.display.minimum)
                    : (
                        definition.minimum !== undefined &&
                        definition.minimum !== null
                            ? Number(definition.minimum)
                            : null
                    )
            );

    const contourAnchor =
        metadata.display && Number.isFinite(Number(metadata.display.anchor))
            ? Number(metadata.display.anchor)
            : (Number.isFinite(Number(definition.anchor)) ? Number(definition.anchor) : 0);

    const explicitLevelsRaw =
        (metadata.display && Array.isArray(metadata.display.levels) && metadata.display.levels.length)
            ? metadata.display.levels
            : (Array.isArray(definition.levels) ? definition.levels : null);

    const explicitLevels = explicitLevelsRaw
        ? explicitLevelsRaw.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
        : null;

    let firstLevel =
        contourAnchor + Math.ceil(
            (minimumValue - contourAnchor) / interval
        ) * interval;

    if (
        Number.isFinite(configuredMinimum)
    ) {

        firstLevel =
            Math.max(
                firstLevel,
                contourAnchor + Math.ceil(
                    (configuredMinimum - contourAnchor) / interval
                ) * interval
            );

    }

    const configuredMaximum =
        metadata.display &&
        metadata.display.maximum !== undefined &&
        metadata.display.maximum !== null
            ? Number(metadata.display.maximum)
            : (
                definition.maximum !== undefined &&
                definition.maximum !== null
                    ? Number(definition.maximum)
                    : null
            );

    let lastLevel =
        Math.floor(
            maximumValue / interval
        ) * interval;

    if (Number.isFinite(configuredMaximum)) {
        lastLevel =
            Math.min(
                lastLevel,
                contourAnchor + Math.floor((configuredMaximum - contourAnchor) / interval) * interval
            );
    }

    const levelsToRender = explicitLevels
        ? explicitLevels.filter(level =>
            level >= minimumValue &&
            level <= maximumValue &&
            (!Number.isFinite(configuredMinimum) || level >= configuredMinimum) &&
            (!Number.isFinite(configuredMaximum) || level <= configuredMaximum)
        )
        : (() => {
            const levels = [];
            if (firstLevel > lastLevel) return levels;
            for (let level = firstLevel; level <= lastLevel + interval * 0.001; level += interval) {
                levels.push(level);
            }
            return levels;
        })();

    if (levelsToRender.length === 0) {
        return;
    }

    const metadataColorScheme =
        metadata.display &&
        metadata.display.color_scheme
            ? metadata.display.color_scheme
            : null;

    const colorScheme =
        field.startsWith("temperature_contours_")
            ? "pressure_temperature_isotherms"
            : field === "dcape"
            ? "dcape"
            : (
                field === "warm_cloud_depth"
                    ? "wcd"
                    : (
                        metadataColorScheme ||
                        definition.colorScheme ||
                        "fixed"
                    )
            );

    const fixedColor =
        (
            metadata.display &&
            metadata.display.color
        ) ||
        definition.color ||
        "#000000";

    const labelsEnabled =
        !metadata.display ||
        metadata.display.labels !== false;

    const labelCandidates = [];

    contourCtx.save();

    const isMslpOrHeightContour =
        field === "sfc_mslp" ||
        field.startsWith("hght_");

    const isPressureTemperatureContour =
        field.startsWith("temperature_contours_") ||
        colorScheme === "pressure_temperature_isotherms";

    const isFrontogenesisContour =
        field.startsWith("frontogenesis_");

    const isThetaContour = field === "theta_2m_contours";
    const isThetaeContour = field === "thetae_2m_contours";

    contourCtx.lineWidth =
        isMslpOrHeightContour
            ? 2.0
            : isPressureTemperatureContour
                ? 2.0
                : isFrontogenesisContour
                    ? 2.0
            : (
                field === "dcape" ||
                field === "warm_cloud_depth" ||
                field === "lcl_height"
            )
                ? 1.5
                : 1.5;

    contourCtx.lineJoin = "round";
    contourCtx.lineCap = "round";

    for (const level of levelsToRender) {

        const contourColor =
            colorScheme === "blues" ? getCinBluesColor(level) :
            colorScheme === "pressure_temperature_isotherms"
                ? (level > 0 ? "#d7191c" : "#0066ff")
                : colorScheme === "dcape"
                ? getDcapeColor(level)
                : (
                    colorScheme === "wcd"
                        ? getWcdColor(level)
                        : (
                            colorScheme === "cape"
                                ? getContourCapeColor(level)
                                : (
                                    colorScheme === "lcl"
                                        ? getLclColor(level)
                                        : (
                                            colorScheme === "stp"
                                                ? getDiscreteContourColor(level, STP_BOUNDS, STP_COLORS)
                                                : colorScheme === "dcp_spc"
                                                    ? (level >= 12 ? "#a00000" : level >= 10 ? "#c40000" : level >= 8 ? "#e00000" : level >= 6 ? "#ff1f1f" : level >= 4 ? "#ff3b1f" : level >= 2 ? "#ff6500" : "#e88924")
                                                : colorScheme === "lhp_spc"
                                                    ? (level >= 20 ? "#ff1f1f" : level >= 16 ? "#ff3b1f" : level >= 12 ? "#f2c300" : level >= 8 ? "#f0b800" : level >= 6 ? "#e89b16" : "#b46b2a")
                                                : colorScheme === "shp_spc"
                                                    ? (level >= 5 ? "#ff00ff" : level >= 3 ? "#ff2a1a" : level >= 2 ? "#f2c300" : level >= 1 ? "#f39a18" : "#9b542b")
                                                : colorScheme === "theta"
                                                    ? "#d7191c"
                                                    : colorScheme === "thetae"
                                                        ? (level >= 330 ? "#138a13" : "#a64b22")
                                                        : fixedColor
                                        )
                                )
                        )
                );

        contourCtx.strokeStyle = contourColor;
        if (isPressureTemperatureContour) {
            const isFreezing = Math.abs(level) < 0.001;
            contourCtx.lineWidth = isFreezing ? 2.8 : 1.5;
            contourCtx.setLineDash(level < -0.001 ? [7, 5] : []);
        } else if (isThetaContour) {
            contourCtx.lineWidth = 1.75;
            contourCtx.setLineDash([]);
        } else if (isThetaeContour) {
            contourCtx.lineWidth = level >= 350 ? 2.5 : (level >= 330 ? 1.75 : 1.5);
            contourCtx.setLineDash([]);
        } else if (
            (colorScheme === "shp_spc" && Math.abs(level - 0.5) < 0.001) ||
            (colorScheme === "lhp_spc" && Math.abs(level - 4) < 0.001)
        ) {
            contourCtx.lineWidth = 1.5;
            contourCtx.setLineDash([7, 6]);
        } else if (
            colorScheme === "dcp_spc" ||
            colorScheme === "lhp_spc" ||
            colorScheme === "shp_spc"
        ) {
            contourCtx.lineWidth =
                (colorScheme === "shp_spc" && level >= 5) ||
                (colorScheme === "lhp_spc" && level >= 16) ||
                (colorScheme === "dcp_spc" && level >= 8)
                    ? 2.2
                    : 1.6;
            contourCtx.setLineDash([]);
        } else {
            contourCtx.setLineDash([]);
        }

        contourCtx.beginPath();

        let segmentCounter = 0;

        const smoothGeometry =
            definition.smoothGeometry === true;

        const smoothIterations =
            Number.isFinite(
                Number(definition.smoothIterations)
            )
                ? Number(definition.smoothIterations)
                : 4;

        const levelSegments = [];

        for (
            let row = 0;
            row < rows - 1;
            row++
        ) {

            const y = row * step;

            for (
                let column = 0;
                column < columns - 1;
                column++
            ) {

                const x = column * step;

                const valueTopLeft =
                    contourValues[
                        row * columns + column
                    ];

                const valueTopRight =
                    contourValues[
                        row * columns + column + 1
                    ];

                const valueBottomLeft =
                    contourValues[
                        (row + 1) * columns + column
                    ];

                const valueBottomRight =
                    contourValues[
                        (row + 1) * columns + column + 1
                    ];

                const segments =
                    getMarchingSegments(
                        x,
                        y,
                        step,
                        valueTopLeft,
                        valueTopRight,
                        valueBottomRight,
                        valueBottomLeft,
                        level
                    );

                if (smoothGeometry) {

                    for (const segment of segments) {
                        levelSegments.push(segment);
                    }

                    continue;

                }

                /*
                 * Original rendering path for every contour product that
                 * does NOT request geometry smoothing.
                 */
                for (
                    const segment
                    of
                    segments
                ) {

                    const pointA = segment[0];
                    const pointB = segment[1];

                    contourCtx.moveTo(
                        pointA.x,
                        pointA.y
                    );

                    contourCtx.lineTo(
                        pointB.x,
                        pointB.y
                    );

                    segmentCounter++;

                    if (
                        labelsEnabled &&
                        segmentCounter % 180 === 0
                    ) {

                        const labelX =
                            (pointA.x + pointB.x) / 2;

                        const labelY =
                            (pointA.y + pointB.y) / 2;

                        if (
                            labelX > 35 &&
                            labelX < width - 35 &&
                            labelY > 20 &&
                            labelY < height - 20
                        ) {

                            const angle =
                                Math.atan2(
                                    pointB.y - pointA.y,
                                    pointB.x - pointA.x
                                );

                            labelCandidates.push({
                                x: labelX,
                                y: labelY,
                                angle,
                                level,
                                color: contourColor
                            });

                        }

                    }

                }

            }

        }

        /*
         * MSLP, geopotential heights, divergence, and frontogenesis are
         * Gaussian-smoothed on the sampled scalar grid before marching squares.
         * Segments are stitched here only to draw continuous contour paths.
         */
        if (smoothGeometry && levelSegments.length > 0) {

            const polylines =
                stitchContourSegments(
                    levelSegments
                );

            for (const rawLine of polylines) {

                if (!rawLine || rawLine.length < 2) {
                    continue;
                }

                /*
                 * Frontogenesis is sampled on a 1-pixel screen grid and the
                 * scalar field is Gaussian-smoothed before marching squares.
                 * When zoomed in, however, the stitched marching-squares
                 * vertices can still reveal tiny straight/grid-aligned steps.
                 * Apply Catmull-Rom interpolation ONLY to frontogenesis paths
                 * so the rendered purple contours remain visually smooth at
                 * close zoom levels without changing the underlying values.
                 * All other contour products retain their existing geometry.
                 */
                const line =
                    field.startsWith("frontogenesis_")
                        ? smoothContourPolyline(rawLine, 6)
                        : rawLine;

                if (!line || line.length < 2) {
                    continue;
                }

                contourCtx.moveTo(
                    line[0].x,
                    line[0].y
                );

                for (let i = 1; i < line.length; i++) {

                    contourCtx.lineTo(
                        line[i].x,
                        line[i].y
                    );

                }

                segmentCounter +=
                    Math.max(
                        1,
                        rawLine.length - 1
                    );

                if (
                    labelsEnabled &&
                    rawLine.length >= 8
                ) {

                    const middleIndex =
                        Math.floor(line.length / 2);

                    const previousIndex =
                        Math.max(
                            0,
                            middleIndex - 2
                        );

                    const nextIndex =
                        Math.min(
                            line.length - 1,
                            middleIndex + 2
                        );

                    const labelPoint =
                        line[middleIndex];

                    if (
                        labelPoint.x > 35 &&
                        labelPoint.x < width - 35 &&
                        labelPoint.y > 20 &&
                        labelPoint.y < height - 20
                    ) {

                        const angle =
                            Math.atan2(
                                line[nextIndex].y - line[previousIndex].y,
                                line[nextIndex].x - line[previousIndex].x
                            );

                        labelCandidates.push({
                            x: labelPoint.x,
                            y: labelPoint.y,
                            angle,
                            level,
                            color: contourColor
                        });

                    }

                }

            }

        }

        contourCtx.stroke();

    }

    contourCtx.restore();

    if (
        generation !==
        contourRenderGeneration
    ) {
        return;
    }

    if (!labelsEnabled) {
        return;
    }

    contourLabelCtx.save();

    const minimumLabelDistance =
        (
            field === "dcape" ||
            field === "warm_cloud_depth" ||
            field === "lcl_height"
        )
            ? 80
            : 95;

    for (
        const candidate
        of
        labelCandidates
    ) {

        if (
            labelTooClose(
                candidate.x,
                candidate.y,
                acceptedLabels,
                minimumLabelDistance
            )
        ) {
            continue;
        }

        /*
         * Matplotlib-style inline labels for MSLP and geopotential heights.
         *
         * Remove only the contour line underneath the text. Because contourCanvas
         * is transparent, the filled weather field remains visible through the
         * gap; this is not a white label box.
         */
        {

            let gapAngle =
                candidate.angle;

            if (gapAngle > Math.PI / 2) {
                gapAngle -= Math.PI;
            }

            if (gapAngle < -Math.PI / 2) {
                gapAngle += Math.PI;
            }

            contourCtx.save();

            contourCtx.translate(
                candidate.x,
                candidate.y
            );

            contourCtx.rotate(
                gapAngle
            );

            contourCtx.font =
                "bold 11px Arial, Helvetica, sans-serif";

            const labelText =
                String(
                    Math.round(
                        candidate.level
                    )
                );

            const labelWidth =
                contourCtx.measureText(
                    labelText
                ).width;

            /*
             * About 4 px of open contour on each side of the text, similar to
             * Matplotlib clabel(inline=True, inline_spacing=...).
             */
            const horizontalPadding =
                4;

            const verticalPadding =
                3;

            contourCtx.clearRect(
                -labelWidth / 2 - horizontalPadding,
                -11 / 2 - verticalPadding,
                labelWidth + horizontalPadding * 2,
                11 + verticalPadding * 2
            );

            contourCtx.restore();

        }

        drawMslpLabel(
            contourLabelCtx,
            candidate.x,
            candidate.y,
            candidate.angle,
            candidate.level,
            candidate.color,
            "rgba(255,255,255,0.0)"
        );

        acceptedLabels.push({
            x: candidate.x,
            y: candidate.y
        });

    }

    contourLabelCtx.restore();

}


/* =========================================================================================
   CONTOUR RENDERER
   ========================================================================================= */

async function renderContours() {

    const generation =
        ++contourRenderGeneration;

    prepareContext(
        contourCanvas,
        contourCtx
    );

    prepareContext(
        contourLabelCanvas,
        contourLabelCtx
    );

    contourCanvas.style.transform =
        "none";

    contourLabelCanvas.style.transform =
        "none";

    const fields = [];

    if (activeOverlays.mslp) {
        fields.push("sfc_mslp");
    }

    if (activeOverlays.dcape) {
        fields.push("dcape");
    }

    if (activeOverlays.warmCloudDepth) {
        fields.push("warm_cloud_depth");
    }

    for (const config of GEOPOTENTIAL_HEIGHT_OVERLAYS) {
        if (activeOverlays[config.stateKey]) fields.push(config.field);
    }
    for (const config of PRESSURE_TEMPERATURE_CONTOUR_OVERLAYS) {
        if (activeOverlays[config.stateKey]) fields.push(config.field);
    }
    for (const config of FRONTOGENESIS_CONTOUR_OVERLAYS) {
        if (activeOverlays[config.stateKey]) fields.push(config.field);
    }

    for (const config of THERMODYNAMIC_CONTOUR_OVERLAYS) {
        if (activeOverlays[config.stateKey]) {
            fields.push(config.field);
        }
    }

    if (fields.length === 0) {
        return;
    }

    const acceptedLabels = [];

    /*
     * Render MSLP first, DCAPE second, Warm Cloud Depth third,
     * followed by any active geopotential-height contours.
     * All contour overlays remain independent and may be displayed simultaneously.
     */
    for (
        const field
        of
        fields
    ) {

        await renderContourField(
            field,
            generation,
            acceptedLabels
        );

        if (
            generation !==
            contourRenderGeneration
        ) {
            return;
        }

    }

}

/* =========================================================================================
   LOAD GEOGRAPHY
   ========================================================================================= */

async function loadGeography() {

    /*
     * counties-10m.json contains both counties and states.
     */
    const response =
        await fetch(
            "data/counties-10m.json"
        );


    if (!response.ok) {

        throw new Error(
            "Unable to load data/counties-10m.json"
        );

    }


    const topology =
        await response.json();


    /*
     * Counties.
     */
    if (
        topology.objects &&
        topology.objects.counties
    ) {

        const counties =
            topojson.feature(

                topology,

                topology.objects.counties

            );


        countyFeatures =
            counties.features || [];

    }


    /*
     * States.
     */
    if (
        topology.objects &&
        topology.objects.states
    ) {

        const states =
            topojson.feature(

                topology,

                topology.objects.states

            );


        stateFeatures =
            states.features || [];

    }


    /*
     * NWS County Warning Area boundaries are stored separately as GeoJSON.
     * Failure to load them should not prevent the rest of the map from working.
     */
    try {

        const cwaResponse =
            await fetch(
                "data/cwa_boundaries.geojson"
            );

        if (cwaResponse.ok) {

            const cwas =
                await cwaResponse.json();

            cwaFeatures =
                cwas.features || [];

            populateCwaSelector();

        }
        else {

            console.warn(
                "CWA Borders enabled but data/cwa_boundaries.geojson returned HTTP " + cwaResponse.status
            );

        }

    }
    catch (error) {

        console.warn(
            "CWA boundaries could not be loaded:",
            error
        );

    }


    /*
     * Cities are stored separately as GeoJSON.
     *
     * Failure to load cities should not prevent the rest of the map
     * from working.
     */
    try {

        const cityResponse =
            await fetch(
                "data/cities.geojson"
            );


        if (
            cityResponse.ok
        ) {

            const cities =
                await cityResponse.json();


            cityFeatures =
                cities.features || [];

        }
        else {

            console.warn(
                "Unable to load data/cities.geojson"
            );

        }

    }
    catch (error) {

        console.warn(
            "Cities could not be loaded:",
            error
        );

    }

}


/* =========================================================================================
   DRAW GEOJSON LINE GEOMETRY
   ========================================================================================= */

function drawGeoJSONLine(
    geometry,
    ctx
) {

    if (!geometry) {

        return;

    }


    /*
     * Draw one coordinate sequence.
     */
    const drawLine =
        coordinates => {

            if (
                !coordinates ||
                coordinates.length === 0
            ) {

                return;

            }


            let started =
                false;


            for (
                const coordinate
                of
                coordinates
            ) {

                if (
                    !Array.isArray(
                        coordinate
                    ) ||

                    coordinate.length < 2
                ) {

                    continue;

                }


                const point =
                    map.project(
                        coordinate
                    );


                if (!started) {

                    ctx.moveTo(

                        point.x,

                        point.y

                    );


                    started =
                        true;

                }
                else {

                    ctx.lineTo(

                        point.x,

                        point.y

                    );

                }

            }

        };


    /*
     * LineString
     */
    if (
        geometry.type ===
        "LineString"
    ) {

        drawLine(
            geometry.coordinates
        );

    }


    /*
     * MultiLineString
     */
    else if (
        geometry.type ===
        "MultiLineString"
    ) {

        for (
            const line
            of
            geometry.coordinates
        ) {

            drawLine(
                line
            );

        }

    }


    /*
     * Polygon
     */
    else if (
        geometry.type ===
        "Polygon"
    ) {

        for (
            const ring
            of
            geometry.coordinates
        ) {

            drawLine(
                ring
            );

        }

    }


    /*
     * MultiPolygon
     */
    else if (
        geometry.type ===
        "MultiPolygon"
    ) {

        for (
            const polygon
            of
            geometry.coordinates
        ) {

            for (
                const ring
                of
                polygon
            ) {

                drawLine(
                    ring
                );

            }

        }

    }

}


/* =========================================================================================
   CITY PROPERTY HELPERS
   ========================================================================================= */

function getCityName(feature) {
    const properties = feature.properties || {};

    return (
        properties.name ||
        properties.NAME ||
        properties.city ||
        properties.CITY ||
        ""
    );
}


function getCityStateFP(feature) {
    const properties = feature.properties || {};

    return String(
        properties.STATEFP ??
        properties.statefp ??
        properties.state_fips ??
        ""
    ).padStart(2, "0");
}


function getCityClass(feature) {
    const properties = feature.properties || {};

    const value =
        properties.city_class ??
        properties.class ??
        properties.rank ??
        properties.scalerank ??
        5;

    const numeric = Number(value);

    return Number.isFinite(numeric)
        ? numeric
        : 5;
}


/*
 * The old cities.geojson contains many real U.S. places that happen to
 * share famous city names.  Their source city_class values make some tiny
 * same-name towns look as important as the major city.
 *
 * These keys preserve the intended major/regional place while allowing the
 * other same-name places to fall back to a much lower priority.
 */
const PRIMARY_SAME_NAME_CITY_KEYS = new Set([
    "dallas|48",
    "houston|48",
    "los angeles|06",
    "new york|36",
    "philadelphia|42",
    "phoenix|04",
    "san antonio|48",
    "san diego|06",
    "denver|08",
    "des moines|19",
    "kansas city|20",
    "kansas city|29",
    "minneapolis|27",
    "st. louis|29",
    "cheyenne|56",
    "dodge city|20",
    "garden city|20",
    "hays|20",
    "rapid city|46"
]);


/*
 * Small operationally useful LBF-area towns can be promoted independently
 * of their population-based source class.
 */
const LBF_CITY_PRIORITY_OVERRIDES = new Map([
    ["north platte|31", 2],
    ["valentine|31", 3],
    ["ogallala|31", 3],
    ["imperial|31", 3],
    ["broken bow|31", 3],
    ["ainsworth|31", 3],
    ["o'neill|31", 3],
    ["burwell|31", 4],
    ["mullen|31", 4],
    ["thedford|31", 4]
]);


/*
 * Places that we intentionally do not want forced onto the operational map.
 * They can remain in cities.geojson without being rendered.
 */
const HIDDEN_CITY_KEYS = new Set([
    "sutherland|31"
]);


function getCityKey(feature) {
    return (
        `${getCityName(feature).trim().toLowerCase()}|` +
        `${getCityStateFP(feature)}`
    );
}


function getEffectiveCityClass(feature) {
    const key = getCityKey(feature);
    const name = getCityName(feature).trim().toLowerCase();
    const sourceClass = getCityClass(feature);

    if (LBF_CITY_PRIORITY_OVERRIDES.has(key)) {
        return LBF_CITY_PRIORITY_OVERRIDES.get(key);
    }

    /*
     * If a name appears more than once in the dataset and one of those
     * occurrences is a recognized primary city, demote the other same-name
     * places.  This is what prevents Denver, Garden City, Minneapolis, etc.
     * from being repeated everywhere at regional zoom.
     */
    const hasPrimaryVersion = cityFeatures.some(candidate => {
        const candidateName = getCityName(candidate).trim().toLowerCase();
        return (
            candidateName === name &&
            PRIMARY_SAME_NAME_CITY_KEYS.has(getCityKey(candidate))
        );
    });

    if (
        hasPrimaryVersion &&
        !PRIMARY_SAME_NAME_CITY_KEYS.has(key)
    ) {
        return Math.max(sourceClass, 5);
    }

    return sourceClass;
}


/* =========================================================================================
   CITY VISIBILITY / PRIORITY
   ========================================================================================= */

function cityVisibleAtZoom(feature, zoom) {
    const key = getCityKey(feature);

    if (HIDDEN_CITY_KEYS.has(key)) {
        return false;
    }

    const cityClass = getEffectiveCityClass(feature);

    if (cityClass <= 1) return zoom >= 3.0;
    if (cityClass === 2) return zoom >= 3.7;
    if (cityClass === 3) return zoom >= 4.6;
    if (cityClass === 4) return zoom >= 5.4;

    /*
     * Truly small towns wait until the user is zoomed in.  This keeps the
     * regional view clean while still allowing local detail.
     */
    return zoom >= 7.0;
}


function getCityPriority(feature) {
    const cityClass = getEffectiveCityClass(feature);
    const key = getCityKey(feature);

    let priority = 1000 - (cityClass * 100);

    if (PRIMARY_SAME_NAME_CITY_KEYS.has(key)) {
        priority += 50;
    }

    if (LBF_CITY_PRIORITY_OVERRIDES.has(key)) {
        priority += 75;
    }

    return priority;
}


/* =========================================================================================
   CITY LABEL SIZE
   ========================================================================================= */

function getCityFont(feature) {
    const cityClass = getEffectiveCityClass(feature);

    if (cityClass <= 1) {
        return "600 12px Arial, Helvetica, sans-serif";
    }

    if (cityClass === 2) {
        return "600 11.5px Arial, Helvetica, sans-serif";
    }

    if (cityClass === 3) {
        return "600 11px Arial, Helvetica, sans-serif";
    }

    if (cityClass === 4) {
        return "600 10.5px Arial, Helvetica, sans-serif";
    }

    return "500 10px Arial, Helvetica, sans-serif";
}


/* =========================================================================================
   CITY COLLISION HELPERS
   ========================================================================================= */

function cityBoxesOverlap(a, b, padding = 4) {
    return !(
        a.right + padding < b.left ||
        a.left - padding > b.right ||
        a.bottom + padding < b.top ||
        a.top - padding > b.bottom
    );
}


function getCityLabelBox(ctx, name, point) {
    const metrics = ctx.measureText(name);

    const width = Math.max(
        1,
        metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight
    );

    const height = Math.max(
        10,
        metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent
    );

    /*
     * A little extra room accounts for the white halo and keeps neighboring
     * labels from visually touching.
     */
    const xPad = 4;
    const yPad = 3;

    return {
        left: point.x - width / 2 - xPad,
        right: point.x + width / 2 + xPad,
        top: point.y - height / 2 - yPad,
        bottom: point.y + height / 2 + yPad
    };
}


/* =========================================================================================
   RENDER CITIES
   ========================================================================================= */

function renderCities() {
    if (!citiesEnabled) {
        return;
    }

    const zoom = map.getZoom();
    const rect = mapWrapper.getBoundingClientRect();

    geographyCtx.save();

    geographyCtx.textAlign = "center";
    geographyCtx.textBaseline = "middle";
    geographyCtx.lineJoin = "round";

    /*
     * Build the eligible list first, then render highest-priority cities
     * first.  Lower-priority labels are skipped whenever they collide with a
     * label that has already been accepted.
     */
    const candidates = [];

    for (const feature of cityFeatures) {
        if (
            !feature.geometry ||
            feature.geometry.type !== "Point" ||
            !cityVisibleAtZoom(feature, zoom)
        ) {
            continue;
        }

        const name = getCityName(feature);
        const coordinates = feature.geometry.coordinates;

        if (
            !name ||
            !Array.isArray(coordinates) ||
            coordinates.length < 2
        ) {
            continue;
        }

        const point = map.project(coordinates);

        if (
            point.x < -100 ||
            point.x > rect.width + 100 ||
            point.y < -50 ||
            point.y > rect.height + 50
        ) {
            continue;
        }

        candidates.push({
            feature,
            name,
            point,
            priority: getCityPriority(feature)
        });
    }

    candidates.sort((a, b) => {
        if (b.priority !== a.priority) {
            return b.priority - a.priority;
        }

        /*
         * Stable geographic tie-breaker so labels do not flicker while
         * panning or zooming.
         */
        const aKey = getCityKey(a.feature);
        const bKey = getCityKey(b.feature);
        return aKey.localeCompare(bKey);
    });

    const occupiedBoxes = [];

    for (const candidate of candidates) {
        const { feature, name, point } = candidate;

        geographyCtx.font = getCityFont(feature);

        const box = getCityLabelBox(
            geographyCtx,
            name,
            point
        );

        const collides = occupiedBoxes.some(existing =>
            cityBoxesOverlap(box, existing, 3)
        );

        if (collides) {
            continue;
        }

        occupiedBoxes.push(box);

        /*
         * No city dots: only clean labels with a small white halo.
         */
        geographyCtx.strokeStyle = "rgba(255,255,255,0.96)";
        geographyCtx.lineWidth = 3;
        geographyCtx.strokeText(name, point.x, point.y);

        geographyCtx.fillStyle = "#333333";
        geographyCtx.fillText(name, point.x, point.y);
    }

    geographyCtx.restore();
}


/* =========================================================================================
   RENDER GEOGRAPHY
   ========================================================================================= */

function renderGeography() {

    prepareContext(

        geographyCanvas,

        geographyCtx

    );


    geographyCtx.save();


    /* -------------------------------------------------------------------------------------
       COUNTIES
       ------------------------------------------------------------------------------------- */

    if (countiesEnabled) {

        geographyCtx.beginPath();

        geographyCtx.strokeStyle =
            "rgba(45,45,45,0.80)";

        geographyCtx.lineWidth =
            0.75;

        for (
            const feature
            of
            countyFeatures
        ) {

            drawGeoJSONLine(

                feature.geometry,

                geographyCtx

            );

        }

        geographyCtx.stroke();

    }


    /* -------------------------------------------------------------------------------------
       STATES

       State borders are drawn above counties and BELOW CWA borders.
       ------------------------------------------------------------------------------------- */

    geographyCtx.beginPath();

    geographyCtx.strokeStyle =
        "rgba(0,0,0,1.0)";

    geographyCtx.lineWidth =
        1.75;

    geographyCtx.lineJoin = "round";
    geographyCtx.lineCap = "round";

    for (const feature of stateFeatures) {
        drawGeoJSONLine(feature.geometry, geographyCtx);
    }

    geographyCtx.stroke();


    /* -------------------------------------------------------------------------------------
       CWA BORDERS — TOP GEOGRAPHIC BOUNDARY LAYER

       Draw order: counties -> states -> CWA borders -> cities.
       Selected office, custom color, line width, and toggle are unchanged.
       Do not erase underlying state borders: CWA lines must remain visible
       on top of both state and county boundaries.
       ------------------------------------------------------------------------------------- */

    if (cwaBordersEnabled) {

        geographyCtx.beginPath();

        geographyCtx.strokeStyle =
            cwaBorderColor;

        geographyCtx.lineWidth =
            cwaBorderWidth;

        geographyCtx.lineJoin = "round";
        geographyCtx.lineCap = "round";

        for (const feature of cwaFeatures) {

            const properties = feature.properties || {};
            const featureCwa = String(
                properties.CWA || properties.WFO || ""
            ).trim().toUpperCase();

            if (
                selectedCwa !== "ALL" &&
                featureCwa !== selectedCwa
            ) {
                continue;
            }

            drawGeoJSONLine(feature.geometry, geographyCtx);
        }

        geographyCtx.stroke();
    }


    geographyCtx.restore();


    /*
     * Cities are drawn last on geographyCanvas so they appear above
     * county and state boundaries.
     *
     * MSLP pressure labels remain above cities because those labels use
     * contourLabelCanvas at z-index 6.
     */
    renderCities();

}


/* =========================================================================================
   DRAW COLOR LEGEND
   ========================================================================================= */

function drawColorLegend(
    colors
) {

    /*
     * Your existing HTML uses #legend-bar.
     *
     * Do not create another legend canvas here.
     */
    if (
        !legendCanvas ||
        !legendCtx
    ) {

        return;

    }


    const rect =
        legendCanvas.getBoundingClientRect();


    /*
     * Use a fallback width/height in case the element has not yet
     * received its final CSS dimensions.
     */
    const width =
        Math.max(

            1,

            Math.round(

                rect.width ||
                legendCanvas.clientWidth ||
                240

            )

        );


    const height =
        Math.max(

            1,

            Math.round(

                rect.height ||
                legendCanvas.clientHeight ||
                18

            )

        );


    const dpr =
        window.devicePixelRatio || 1;


    legendCanvas.width =
        Math.round(
            width *
            dpr
        );


    legendCanvas.height =
        Math.round(
            height *
            dpr
        );


    legendCtx.setTransform(

        dpr,

        0,

        0,

        dpr,

        0,

        0

    );


    legendCtx.clearRect(

        0,

        0,

        width,

        height

    );


    const colorWidth =
        width /
        colors.length;


    for (
        let index = 0;
        index < colors.length;
        index++
    ) {

        legendCtx.fillStyle =
            colors[
                index
            ];


        legendCtx.fillRect(

            index *
            colorWidth,

            0,

            Math.ceil(
                colorWidth +
                0.5
            ),

            height

        );

    }

}


function drawProportionalColorLegend(colors, bounds) {
    if (!legendCanvas || !legendCtx || !Array.isArray(bounds) || bounds.length < 2) return;
    const rect = legendCanvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || legendCanvas.clientWidth || 240));
    const height = Math.max(1, Math.round(rect.height || legendCanvas.clientHeight || 18));
    const dpr = window.devicePixelRatio || 1;
    legendCanvas.width = Math.round(width * dpr);
    legendCanvas.height = Math.round(height * dpr);
    legendCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    legendCtx.clearRect(0, 0, width, height);
    const min = bounds[0], max = bounds[bounds.length - 1], span = max - min;
    for (let i = 0; i < colors.length; i++) {
        const x0 = ((bounds[i] - min) / span) * width;
        const x1 = ((bounds[i + 1] - min) / span) * width;
        legendCtx.fillStyle = colors[i];
        legendCtx.fillRect(x0, 0, Math.ceil(x1 - x0 + 0.5), height);
    }
}

function getResponsiveLegendTicks(ticks, bounds, proportional = false) {
    if (!Array.isArray(ticks) || ticks.length <= 2 || !legendLabels) return ticks || [];

    const width = Math.max(1, legendLabels.getBoundingClientRect().width || legendLabels.clientWidth || 240);
    // Approximate label footprint plus breathing room. Multi-panel legends intentionally
    // show fewer ticks rather than squeezing labels together.
    const isFourPanel = document.body.classList.contains("mp-layout-4");
    const isTwoPanel = document.body.classList.contains("mp-layout-2");
    const minGapPx = isFourPanel ? 32 : isTwoPanel ? 36 : width <= 250 ? 42 : width <= 320 ? 46 : width <= 390 ? 50 : 54;

    const positionFor = tick => {
        const value = typeof tick === "object" ? tick.value : tick;
        if (proportional) {
            const min = bounds[0], max = bounds[bounds.length - 1];
            return max === min ? 0 : ((value - min) / (max - min)) * width;
        }
        return (getLegendBoundaryPosition(value, bounds) / 100) * width;
    };

    const kept = [ticks[0]];
    let lastX = positionFor(ticks[0]);
    const lastTick = ticks[ticks.length - 1];
    const lastTickX = positionFor(lastTick);

    for (let i = 1; i < ticks.length - 1; i++) {
        const x = positionFor(ticks[i]);
        // Reserve space for the final label too.
        if (x - lastX >= minGapPx && lastTickX - x >= minGapPx) {
            kept.push(ticks[i]);
            lastX = x;
        }
    }
    kept.push(lastTick);
    return kept;
}

function renderProportionalLegendLabels(ticks, bounds) {
    if (!legendLabels) return;
    legendLabels.innerHTML = "";
    const min = bounds[0], max = bounds[bounds.length - 1], span = max - min;
    const visibleTicks = getResponsiveLegendTicks(ticks, bounds, true);
    visibleTicks.forEach((tick, index) => {
        const value = typeof tick === "object" ? tick.value : tick;
        const label = typeof tick === "object" ? tick.label : String(tick);
        const position = Math.max(0, Math.min(100, ((value - min) / span) * 100));
        const el = document.createElement("span");
        el.className = "legend-label";
        el.textContent = label;
        el.style.left = `${position}%`;
        if (index === 0 || position <= 0.01) el.classList.add("legend-label-first");
        if (index === visibleTicks.length - 1 || position >= 99.99) el.classList.add("legend-label-last");
        legendLabels.appendChild(el);
    });
}

/* =========================================================================================
   LEGEND LABEL HELPERS
   ========================================================================================= */

/*
 * Return the horizontal position of a value on a discrete color bar.
 *
 * The legend itself draws every color bin at equal width. For palettes
 * with non-uniform numerical bounds (CAPE, STP, SCP, etc.), positioning
 * labels by raw min/max value would not line up with the displayed color
 * bins. This helper therefore positions each label by its location in the
 * boundary array, matching the color bar exactly.
 */
function getLegendBoundaryPosition(value, bounds) {

    if (!Array.isArray(bounds) || bounds.length < 2) {
        return 0;
    }

    const lastIndex = bounds.length - 1;

    if (value <= bounds[0]) {
        return 0;
    }

    if (value >= bounds[lastIndex]) {
        return 100;
    }

    for (let index = 0; index < lastIndex; index++) {

        const lower = bounds[index];
        const upper = bounds[index + 1];

        if (value >= lower && value <= upper) {

            const fraction =
                upper === lower
                    ? 0
                    : (value - lower) / (upper - lower);

            return ((index + fraction) / lastIndex) * 100;
        }
    }

    return 100;
}


function renderLegendLabels(ticks, bounds) {

    if (!legendLabels) {
        return;
    }

    legendLabels.innerHTML = "";

    const visibleTicks = getResponsiveLegendTicks(ticks, bounds, false);
    visibleTicks.forEach((tick, tickIndex) => {

        const value =
            typeof tick === "object"
                ? tick.value
                : tick;

        const label =
            typeof tick === "object"
                ? tick.label
                : String(tick);

        const span = document.createElement("span");
        span.className = "legend-label";
        span.textContent = label;

        const position = getLegendBoundaryPosition(value, bounds);
        span.style.left = `${position}%`;

        /*
         * Keep the first and last labels fully inside the legend card.
         */
        if (tickIndex === 0 || position <= 0.01) {
            span.classList.add("legend-label-first");
        }

        if (tickIndex === visibleTicks.length - 1 || position >= 99.99) {
            span.classList.add("legend-label-last");
        }

        legendLabels.appendChild(span);
    });
}


/* =========================================================================================
   UPDATE LEGEND
   ========================================================================================= */

function updateLegend() {

    if (
        !legend ||
        !legendTitle ||
        !legendLabels
    ) {
        return;
    }

    if (
        !activeField ||
        activeField === "none"
    ) {
        legend.style.display = "none";
        return;
    }

    const field = WEATHER_FIELDS[activeField];

    if (!field) {
        legend.style.display = "none";
        return;
    }

    legend.style.display = "";

    legendTitle.textContent =
        field.units
            ? `${field.name} (${field.units})`
            : field.name;


    if (field.type === "q_vector_divergence") {
        drawColorLegend(QDIV_COLORS);
        renderLegendLabels([-50,-40,-30,-20,-10,-5,5,10,20,30,40,50], QDIV_BOUNDS);
    }

    /* CIN: discrete bins matching the numerical tile values. */
    if (field.type === "cin") {
        const displayedColors = CIN_BOUNDS.slice(0, -1).map((_, i) => {
            const idx = Math.floor(i * (CIN_COLORS.length - 1) / (CIN_BOUNDS.length - 2));
            return CIN_COLORS[idx];
        });
        drawColorLegend(displayedColors);
        renderLegendLabels([-1050, -800, -600, -400, -200, -100, -50, 0], CIN_BOUNDS);
    }

    /* CAPE family. */
    if (field.type === "cape") {

        drawColorLegend(CAPE_COLORS);

        renderLegendLabels(
            [100, 1000, 2000, 3000, 4000, 5000, { value: 6000, label: "6000+" }],
            CAPE_BOUNDS
        );
    }


    /* 0–3 km MLCAPE. */
    else if (field.type === "cape_0_3km") {

        drawColorLegend(CAPE_03KM_COLORS.slice(1));

        renderLegendLabels(
            [10, 100, 200, 300, 400, 500, { value: 600, label: "600+" }],
            CAPE_03KM_BOUNDS
        );
    }


    /* 925 / 850 / 700 mb wind speed. */
    else if (field.type === "wind_midlevel") {

        drawColorLegend(MIDLEVEL_WIND_COLORS);

        renderLegendLabels(
            [20, 30, 40, 50, 60, 70, { value: 80, label: "80+" }],
            MIDLEVEL_WIND_BOUNDS
        );
    }


    /* 500 mb wind speed. */
    else if (field.type === "wind_500") {

        drawColorLegend(WIND_500_COLORS);

        renderLegendLabels(
            [20, 40, 60, 80, 100, 120, { value: 140, label: "140+" }],
            WIND_500_BOUNDS
        );
    }


    /* 250 mb wind speed. */
    else if (field.type === "wind_250") {

        drawColorLegend(WIND_250_COLORS);

        renderLegendLabels(
            [50, 70, 90, 110, 130, 150, { value: 170, label: "170+" }],
            WIND_250_BOUNDS
        );
    }


    /* Precipitable Water (inches). */
    else if (field.type === "pwat") {

        drawColorLegend(PWAT_COLORS);

        renderLegendLabels(
            [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, { value: 3.0, label: "3.0+" }],
            PWAT_BOUNDS
        );
    }


    /* Significant Tornado Parameter (Effective Layer). */
    else if (field.type === "stp") {

        drawColorLegend(STP_COLORS);

        renderLegendLabels(
            [0, 1, 2, 3, 4, 5, 6, 8, { value: 10.5, label: "10.5+" }],
            STP_BOUNDS
        );
    }


    /* Right- / Left-moving Supercell Composite Parameter. */
    else if (field.type === "scp") {

        drawColorLegend(SCP_COLORS);

        renderLegendLabels(
            [0, 2, 5, 10, 20, 30, 40, { value: 48, label: "48+" }],
            SCP_BOUNDS
        );
    }


    /* 2-m temperature. */
    else if (field.type === "temperature") {

        drawColorLegend(TEMPERATURE_COLORS);

        renderLegendLabels(
            [-100, -50, 0, 50, 100, 130],
            TEMPERATURE_BOUNDS
        );
    }


    /* Pressure-level temperature. */
    else if (field.type === "pressure_temperature") {

        drawProportionalColorLegend(PRESSURE_TEMPERATURE_COLORS, PRESSURE_TEMPERATURE_BOUNDS);

        renderProportionalLegendLabels(
            [-50, -45, -40, -35, -30, -25, -20, -15, -10, -5, 0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39],
            PRESSURE_TEMPERATURE_BOUNDS
        );
    }


    /* Pressure-level temperature advection. */
    else if (field.type === "temperature_advection") {
        drawColorLegend(TEMPERATURE_ADVECTION_COLORS);
        renderLegendLabels([-16, -12, -8, -4, 0, 4, 8, 12, 16], TEMPERATURE_ADVECTION_BOUNDS);
    }


    /* Lapse rates. */
    else if (field.type === "lapse_rate") {

        drawProportionalColorLegend(LAPSE_RATE_COLORS, LAPSE_RATE_BOUNDS);

        renderProportionalLegendLabels(
            [0, 3, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10],
            LAPSE_RATE_BOUNDS
        );
    }


    /* Storm-relative helicity. */
    else if (field.type === "srh") {
        drawProportionalColorLegend(SRH_COLORS, SRH_BOUNDS);
        renderProportionalLegendLabels(
            [0, 100, 200, 300, 400, 500, 600, 800, 1000],
            SRH_BOUNDS
        );
    }


    /* Energy Helicity Index. */
    else if (field.type === "ehi") {
        drawProportionalColorLegend(EHI_COLORS, EHI_BOUNDS);
        renderProportionalLegendLabels(
            [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16],
            EHI_BOUNDS
        );
    }

    /* Signed 2-D Petterssen frontogenesis / frontolysis. */
    else if (field.type === "petterssen_fgen") {
        drawProportionalColorLegend(PETTERSSEN_FGEN_COLORS, PETTERSSEN_FGEN_BOUNDS);
        renderProportionalLegendLabels([-20,-15,-10,-5,0,5,10,15,20], PETTERSSEN_FGEN_BOUNDS);
    }

    /* Pressure-level relative vorticity. */
    else if (field.type === "relative_vorticity") {
        drawProportionalColorLegend(RELATIVE_VORTICITY_COLORS, RELATIVE_VORTICITY_BOUNDS);
        renderProportionalLegendLabels(
            [-40, -30, -20, -10, 0, 10, 20, 30, 40, 50],
            RELATIVE_VORTICITY_BOUNDS
        );
    }

    /* Surface total deformation. */
    else if (field.type === "surface_deformation") {
        drawProportionalColorLegend(SFC_DEFORMATION_COLORS, SFC_DEFORMATION_BOUNDS);
        renderProportionalLegendLabels(
            [0, 2, 4, 6, 8, 10, 12, 16, 20],
            SFC_DEFORMATION_BOUNDS
        );
    }


    /* 2-m equivalent potential temperature. */
    else if (field.type === "thetae") {

        drawColorLegend(THETAE_COLORS);

        renderLegendLabels(
            [239, 260, 280, 300, 320, 340, 360, 370],
            THETAE_BOUNDS
        );
    }


    /* Relative humidity. */
    else if (field.type === "rh") {

        drawColorLegend(RH_COLORS);

        renderLegendLabels(
            [0, 20, 40, 60, 80, 100],
            RH_BOUNDS
        );
    }


    /* Surface dewpoint. */
    else if (field.type === "dewpoint") {

        drawColorLegend(DEWPOINT_COLORS);

        /*
         * The supplied dewpoint palette contains one-degree bins spanning
         * approximately -40 through 90 F. Build matching boundaries here
         * solely for legend positioning; the existing dewpoint rendering
         * and palette lookup are unchanged.
         */
        const dewpointLegendBounds =
            Array.from(
                { length: DEWPOINT_COLORS.length + 1 },
                (_, index) => -40 + index
            );

        renderLegendLabels(
            [-40, -20, 0, 20, 40, 60, 80, 90],
            dewpointLegendBounds
        );
    }
}


/* =========================================================================================
   CURSOR SAMPLE
   ========================================================================================= */

let lastCursorUpdate = 0;

function getActiveContourSamples() {

    const samples = [];

    const add = (enabled, field) => {
        if (enabled && CONTOUR_FIELDS[field]) {
            samples.push(field);
        }
    };

    add(activeOverlays.mslp, "sfc_mslp");
    add(activeOverlays.dcape, "dcape");
    add(activeOverlays.warmCloudDepth, "warm_cloud_depth");
    add(activeOverlays.lclHeight, "lcl_height");
    add(activeOverlays.stpEff, "stp_eff_contours");
    for (const config of THERMODYNAMIC_CONTOUR_OVERLAYS) {
        add(activeOverlays[config.stateKey], config.field);
    }

    for (const config of GEOPOTENTIAL_HEIGHT_OVERLAYS) {
        add(activeOverlays[config.stateKey], config.field);
    }
    for (const config of PRESSURE_TEMPERATURE_CONTOUR_OVERLAYS) {
        add(activeOverlays[config.stateKey], config.field);
    }
    for (const config of FRONTOGENESIS_CONTOUR_OVERLAYS) {
        add(activeOverlays[config.stateKey], config.field);
    }

    const divergenceFields = [
        ["divergence925", "divergence_925mb"],
        ["divergence850", "divergence_850mb"],
        ["divergence700", "divergence_700mb"],
        ["divergence500", "divergence_500mb"],
        ["divergence250", "divergence_250mb"]
    ];

    for (const [stateKey, field] of divergenceFields) {
        add(activeOverlays[stateKey], field);
    }

    return samples;
}

function getActiveVectorSamples() {
    return VECTOR_OVERLAY_CONFIG
        .filter(config => activeOverlays[config.stateKey])
        .map(config => config.field);
}

function formatScalarSample(field, value) {

    if (!Number.isFinite(value)) return "N/A";

    const definition = WEATHER_FIELDS[field] || {};

    if (definition.type === "cape" || definition.type === "cape_0_3km") {
        return `${Math.round(value)} J/kg`;
    }
    if (definition.type === "temperature" || definition.type === "dewpoint") {
        return `${value.toFixed(1)} °F`;
    }
    if (definition.type === "pressure_temperature") {
        return `${value.toFixed(1)} °C`;
    }
    if (definition.type === "temperature_advection") {
        return `${value.toFixed(1)} °C/3 hr`;
    }
    if (definition.type === "lapse_rate") {
        return `${value.toFixed(1)} °C/km`;
    }
    if (definition.type === "srh") {
        return `${Math.round(value)} m²/s²`;
    }
    if (definition.type === "ehi") {
        return value.toFixed(1);
    }
    if (definition.type === "petterssen_fgen") {
        return `${value.toFixed(1)} K/(100 km)/3 h`;
    }
    if (definition.type === "relative_vorticity") {
        return `${value.toFixed(1)} ×10⁻⁵ s⁻¹`;
    }
    if (definition.type === "surface_deformation") {
        return `${value.toFixed(1)} ×10⁻⁵ s⁻¹`;
    }
    if (definition.type === "thetae") {
        return `${value.toFixed(1)} K`;
    }
    if (definition.type === "rh") {
        return `${value.toFixed(0)} %`;
    }
    if (definition.type === "wind_midlevel" || definition.type === "wind_500" || definition.type === "wind_250") {
        return `${Math.round(value)} kt`;
    }
    if (definition.type === "pwat") {
        return `${value.toFixed(2)} in`;
    }
    if (definition.type === "stp" || definition.type === "scp") {
        return value.toFixed(1);
    }

    const units = definition.units || "";
    return `${value.toFixed(1)}${units ? ` ${units}` : ""}`;
}

function formatContourSample(field, value) {

    if (!Number.isFinite(value)) return "N/A";

    const definition = CONTOUR_FIELDS[field] || {};
    const units = definition.units || "";

    if (field === "sfc_mslp") return `${value.toFixed(1)} hPa`;
    if (field.startsWith("hght_")) return `${Math.round(value)} m`;
    if (field.startsWith("temperature_contours_")) return `${value.toFixed(1)} °C`;
    if (field === "dcape") return `${Math.round(value)} J/kg`;
    if (field === "lcl_height") return `${Math.round(value)} m AGL`;
    if (field === "warm_cloud_depth") return `${Math.round(value)} m`;
    if (field.endsWith("cin_contours")) return `${Math.round(value)} J/kg`;
    if (field === "stp_eff_contours") return value.toFixed(1);
    if (field === "theta_2m_contours" || field === "thetae_2m_contours") return `${Math.round(value)} K`;
    if (field.startsWith("divergence_")) return `${value.toFixed(1)} ${units}`;

    return `${value.toFixed(1)}${units ? ` ${units}` : ""}`;
}

function formatVectorSample(vector) {
    if (!vector || !Number.isFinite(vector.u) || !Number.isFinite(vector.v)) {
        return "N/A";
    }
    return `${Math.round(Math.hypot(vector.u, vector.v))} kt`;
}

async function preloadCursorNeighborhood(kind, field, z, tileX, tileY) {

    const jobs = [];

    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (kind === "scalar") {
                jobs.push(loadScalarTile(field, z, tileX + dx, tileY + dy,
                    currentRun, dx === 0 && dy === 0 ? -2 : 1));
            }
            else if (kind === "vector") {
                jobs.push(loadVectorTile(field, z, tileX + dx, tileY + dy,
                    currentRun, dx === 0 && dy === 0 ? -2 : 1));
            }
            else if (kind === "contour") {
                jobs.push(loadContourTile(field, z, tileX + dx, tileY + dy,
                    currentRun, dx === 0 && dy === 0 ? -2 : 1));
            }
        }
    }

    await Promise.all(jobs);
}

function positionCursorPanel(event) {

    if (!cursorPanel) return;

    const wrapper = document.getElementById("map-wrapper");
    if (!wrapper) return;

    const gap = 16;
    const padding = 10;
    const panelWidth = cursorPanel.offsetWidth || 230;
    const panelHeight = cursorPanel.offsetHeight || 80;

    let left = event.point.x + gap;
    let top = event.point.y + gap;

    if (left + panelWidth + padding > wrapper.clientWidth) {
        left = event.point.x - panelWidth - gap;
    }

    if (top + panelHeight + padding > wrapper.clientHeight) {
        top = event.point.y - panelHeight - gap;
    }

    cursorPanel.style.left = `${Math.max(padding, left)}px`;
    cursorPanel.style.top = `${Math.max(padding, top)}px`;
}

function renderCursorSamples(rows, event) {

    if (!cursorPanel || !cursorSampleRows) return;

    cursorSampleRows.innerHTML = "";

    if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "cursor-sample-empty";
        empty.textContent = "No active weather layers";
        cursorSampleRows.appendChild(empty);
    }
    else {
        for (const row of rows) {
            const line = document.createElement("div");
            line.className = "cursor-sample-row";

            const name = document.createElement("span");
            name.className = "cursor-sample-name";
            name.textContent = row.name;

            const value = document.createElement("span");
            value.className = "cursor-sample-value";
            value.textContent = row.value;

            line.appendChild(name);
            line.appendChild(value);
            cursorSampleRows.appendChild(line);
        }
    }

    cursorPanel.classList.add("visible");
    cursorPanel.setAttribute("aria-hidden", "false");
    positionCursorPanel(event);
}

async function updateCursor(event) {

    if (!cursorSampleEnabled) return;

    const now = performance.now();
    if (now - lastCursorUpdate < 70) return;
    lastCursorUpdate = now;

    const generation = ++cursorGeneration;
    const z = getDataZoom();
    const tileX = Math.floor(lonToTileX(event.lngLat.lng, z));
    const tileY = Math.floor(latToTileY(event.lngLat.lat, z));

    const scalarFields = [];
    if (activeField && activeField !== "none" && WEATHER_FIELDS[activeField]) {
        scalarFields.push(activeField);
    }

    const contourFields = getActiveContourSamples();
    const vectorFields = getActiveVectorSamples();

    const preloadJobs = [];

    for (const field of scalarFields) {
        preloadJobs.push(preloadCursorNeighborhood("scalar", field, z, tileX, tileY));
    }
    for (const field of contourFields) {
        preloadJobs.push(preloadCursorNeighborhood("contour", field, z, tileX, tileY));
    }
    for (const field of vectorFields) {
        preloadJobs.push(preloadCursorNeighborhood("vector", field, z, tileX, tileY));
    }

    await Promise.all(preloadJobs);

    if (generation !== cursorGeneration || !cursorSampleEnabled) return;

    const rows = [];

    for (const field of scalarFields) {
        const value = sampleScalar(field, event.lngLat.lng, event.lngLat.lat, z, false);
        rows.push({
            name: WEATHER_FIELDS[field].shortName || WEATHER_FIELDS[field].name,
            value: formatScalarSample(field, value)
        });
    }

    for (const field of contourFields) {
        const value = sampleScalar(field, event.lngLat.lng, event.lngLat.lat, z, true);
        const definition = CONTOUR_FIELDS[field];
        rows.push({
            name: definition.shortName || definition.name,
            value: formatContourSample(field, value)
        });
    }

    for (const field of vectorFields) {
        const vector = sampleVector(field, event.lngLat.lng, event.lngLat.lat, z);
        const definition = VECTOR_FIELDS[field];
        rows.push({
            name: definition.shortName || definition.name,
            value: formatVectorSample(vector)
        });
    }

    renderCursorSamples(rows, event);
}

function clearCursor() {
    cursorGeneration++;
    if (cursorPanel) {
        cursorPanel.classList.remove("visible");
        cursorPanel.setAttribute("aria-hidden", "true");
    }
}

function setCursorSampleEnabled(enabled) {
    cursorSampleEnabled = Boolean(enabled);
    clearCursor();

    const canvas = map && map.getCanvas ? map.getCanvas() : null;
    if (canvas) {
        canvas.style.cursor = cursorSampleEnabled ? "crosshair" : "";
    }
}

if (cursorSampleToggle) {
    cursorSampleToggle.addEventListener("change", event => {
        setCursorSampleEnabled(event.target.checked);
    });
}


/* =========================================================================================
   FIT MAP TO SECTOR
   ========================================================================================= */

function fitSector(
    sectorKey,
    options = {}
) {

    const sector =
        sectors[
            sectorKey
        ];


    if (!sector) {

        console.warn(
            `Unknown sector: ${sectorKey}`
        );


        return;

    }


    const duration =
        options.duration !== undefined
            ? options.duration
            : 700;


    const padding =
        options.padding !== undefined
            ? options.padding
            : 20;


    map.fitBounds(

        sector.bounds,

        {

            padding,

            duration

        }

    );

}


/* =========================================================================================
   INVALIDATE NUMERICAL RENDERS
   ========================================================================================= */

function invalidateNumericalRenders() {

    scalarRenderGeneration++;

    vectorRenderGeneration++;

    contourRenderGeneration++;

    cursorGeneration++;

}


/* =========================================================================================
   RENDER ALL
   ========================================================================================= */

async function renderAll() {

    /*
     * Any camera CSS transform from an active pan/zoom must be removed
     * before producing a fresh numerical render.
     */
    resetNumericalCanvasTransforms();


    /*
     * Draw geography immediately so the map never looks empty while
     * numerical tiles are loading.
     */
    renderGeography();


    /*
     * The three numerical systems are independent:
     *
     *   filled scalar field
     *   wind barbs
     *   MSLP contours
     */
    await Promise.all([

        renderWeather(),

        renderVectors(),

        renderContours()

    ]);


    /*
     * Redraw geography after the numerical fields.
     *
     * geographyCanvas has z-index 5, so this remains above the filled
     * fields, barbs, and contour lines.
     *
     * contourLabelCanvas is z-index 6, so MSLP numbers remain above
     * geography even after this redraw.
     */
    renderGeography();


    captureCanvasCamera();

}


/* =========================================================================================
   MAP MOVE START
   ========================================================================================= */

map.on(

    "movestart",

    () => {

        /*
         * Capture the exact camera represented by the existing numerical
         * canvases. During movement those canvases will be transformed to
         * follow the live MapLibre camera.
         */
        captureCanvasCamera();

    }

);


/* =========================================================================================
   MAP MOVE
   ========================================================================================= */

map.on(

    "move",

    () => {

        /*
         * Keep the already-rendered numerical layers visually attached
         * to the map while the user pans or zooms.
         */
        transformNumericalCanvases();


        /*
         * Geography is inexpensive enough to redraw live.
         */
        renderGeography();

    }

);


/* =========================================================================================
   MAP MOVE END
   ========================================================================================= */

map.on(

    "moveend",

    () => {

        clearTimeout(
            moveEndTimer
        );


        /*
         * Small debounce prevents multiple expensive full-resolution
         * renders at the end of a single interaction.
         */
        moveEndTimer =
            setTimeout(

                async () => {

                    /*
                     * Cancel any render that may still be associated with
                     * the previous camera.
                     */
                    invalidateNumericalRenders();

                    const holdover = beginNumericalHoldover();
                    resetNumericalCanvasTransforms();

                    try {
                        await Promise.all([
                            renderWeather(),
                            renderVectors(),
                            renderContours()
                        ]);
                        renderGeography();
                        captureCanvasCamera();
                    } finally {
                        finishNumericalHoldover(holdover);
                    }

                },

                100

            );

    }

);


/* =========================================================================================
   CURSOR EVENTS
   ========================================================================================= */

map.on(

    "mousemove",

    event => {

        updateCursor(
            event
        );

    }

);


map.on(

    "mouseout",

    () => {

        clearCursor();

    }

);


/* =========================================================================================
   MAP RESIZE
   ========================================================================================= */

map.on(

    "resize",

    () => {

        invalidateNumericalRenders();


        resetNumericalCanvasTransforms();


        resizeAllCanvases();


        renderAll();

    }

);


/* =========================================================================================
   INDEPENDENT CLEAR BUTTONS: preserve unrelated layers.
   ========================================================================================= */
const clearFillButton = document.getElementById("clear-fill");
const clearContoursButton = document.getElementById("clear-contours");

if (clearFillButton) {
    clearFillButton.addEventListener("click", async () => {
        activeField = "none";
        if (fieldSelect) fieldSelect.value = "none";
        document.querySelectorAll("#sidebar .field-choice.active")
            .forEach(button => button.classList.remove("active"));
        scalarRenderGeneration++;
        cursorGeneration++;
        clearCursor();
        updateLegend();
        resetNumericalCanvasTransforms();
        await renderWeather();
        renderGeography();
        captureCanvasCamera();
        updateActiveLayersStrip();
    });
}

if (clearContoursButton) {
    clearContoursButton.addEventListener("click", async () => {
        const contourKeys = new Set(["mslp", "dcape", "warmCloudDepth"]);
        const configs = [
            ...GEOPOTENTIAL_HEIGHT_OVERLAYS,
            ...PRESSURE_TEMPERATURE_CONTOUR_OVERLAYS,
            ...FRONTOGENESIS_CONTOUR_OVERLAYS,
            ...THERMODYNAMIC_CONTOUR_OVERLAYS
        ];
        for (const config of configs) contourKeys.add(config.stateKey);
        for (const key of contourKeys) activeOverlays[key] = false;

        for (const id of ["mslp-toggle", "dcape-toggle", "warm-cloud-depth-toggle"]) {
            const input = document.getElementById(id);
            if (input) input.checked = false;
        }
        for (const config of configs) {
            const input = document.getElementById(config.toggleId);
            if (input) input.checked = false;
        }
        contourRenderGeneration++;
        resetNumericalCanvasTransforms();
        await renderContours();
        renderGeography();
        captureCanvasCamera();
        updateActiveLayersStrip();
    });
}

/* =========================================================================================
   FILLED FIELD CHANGE
   ========================================================================================= */

if (fieldSelect) {

    fieldSelect.addEventListener(

        "change",

        async event => {

            activeField =
                event.target.value;


            scalarRenderGeneration++;

            cursorGeneration++;


            clearCursor();


            updateLegend();


            resetNumericalCanvasTransforms();


            await renderWeather();


            /*
             * Changing the filled field does not disable or alter MSLP.
             *
             * Redrawing it here ensures the contour layer remains aligned
             * with the freshly rendered scalar layer.
             */
            if (
                activeOverlays.mslp ||
                activeOverlays.dcape ||
                activeOverlays.warmCloudDepth ||
                activeOverlays.lclHeight ||
                activeOverlays.stpEff ||
                activeOverlays.dcpContours ||
                activeOverlays.lhpContours ||
                activeOverlays.shpContours ||
                activeOverlays.divergence925 ||
                activeOverlays.divergence850 ||
                activeOverlays.divergence700 ||
                activeOverlays.divergence500 ||
                activeOverlays.divergence250
            ) {

                await renderContours();

            }


            renderGeography();


            captureCanvasCamera();

        }

    );

}


/* =========================================================================================
   SECTOR CHANGE
   ========================================================================================= */

if (sectorSelect) {

    sectorSelect.addEventListener(

        "change",

        event => {

            /*
             * move/moveend handle the numerical redraw automatically.
             */
            fitSector(
                event.target.value
            );

        }

    );

}


/* =========================================================================================
   COUNTIES TOGGLE
   ========================================================================================= */

if (countiesToggle) {

    countiesToggle.addEventListener(
        "change",
        event => {
            countiesEnabled = event.target.checked;
            renderGeography();
        }
    );

}


/* =========================================================================================
   CITIES TOGGLE
   ========================================================================================= */

if (citiesToggle) {

    citiesToggle.addEventListener(

        "change",

        event => {

            citiesEnabled =
                event.target.checked;


            renderGeography();

        }

    );

}


/* =========================================================================================
   CWA BORDER CONTROLS
   ========================================================================================= */

if (cwaBordersToggle) {

    cwaBordersToggle.addEventListener(
        "change",
        event => {
            cwaBordersEnabled = event.target.checked;
            renderGeography();
        }
    );

}

if (cwaSelector) {

    cwaSelector.addEventListener(
        "change",
        event => {
            selectedCwa = event.target.value || "ALL";
            renderGeography();
        }
    );

}

if (cwaBorderColorInput) {

    cwaBorderColorInput.addEventListener(
        "input",
        event => {
            cwaBorderColor = event.target.value || "#6f42c1";
            renderGeography();
        }
    );

}

if (cwaBorderWidthSelect) {

    cwaBorderWidthSelect.addEventListener(
        "change",
        event => {
            const width = Number(event.target.value);
            cwaBorderWidth = Number.isFinite(width) ? width : 2.0;
            renderGeography();
        }
    );

}


/* =========================================================================================
   WIND TOGGLES + PER-LAYER COLOR PICKERS
   ========================================================================================= */

for (const config of VECTOR_OVERLAY_CONFIG) {

    const toggle =
        vectorToggleElements[config.field] ||
        document.getElementById(config.toggleId);

    if (toggle) {

        toggle.addEventListener(
            "change",
            async event => {

                activeOverlays[config.stateKey] =
                    event.target.checked;

                vectorRenderGeneration++;
                resetNumericalCanvasTransforms();
                await renderVectors();
                captureCanvasCamera();
            }
        );
    }

    const colorInput =
        vectorColorElements[config.field];

    if (colorInput) {

        colorInput.addEventListener(
            "input",
            async event => {

                vectorColors[config.field] =
                    event.target.value || "#000000";

                requestAnimationFrame(updateActiveLayersStrip);

                if (activeOverlays[config.stateKey]) {
                    vectorRenderGeneration++;
                    resetNumericalCanvasTransforms();
                    await renderVectors();
                    captureCanvasCamera();
                }
            }
        );
    }
}


/* =========================================================================================
   MSLP TOGGLE
   ========================================================================================= */

if (mslpToggle) {

    mslpToggle.addEventListener(

        "change",

        async event => {

            activeOverlays.mslp =
                event.target.checked;


            contourRenderGeneration++;


            resetNumericalCanvasTransforms();


            /*
             * renderContours clears both the line canvas and the label
             * canvas before checking whether MSLP is enabled.
             *
             * Therefore unchecking MSLP immediately removes both.
             */
            await renderContours();


            renderGeography();


            captureCanvasCamera();

        }

    );

}


/* =========================================================================================
   DCAPE TOGGLE
   ========================================================================================= */

if (dcapeToggle) {

    dcapeToggle.addEventListener(

        "change",

        async event => {

            activeOverlays.dcape =
                event.target.checked;

            contourRenderGeneration++;

            resetNumericalCanvasTransforms();

            await renderContours();

            renderGeography();

            captureCanvasCamera();

        }

    );

}


/* =========================================================================================
   WARM CLOUD DEPTH TOGGLE
   ========================================================================================= */

if (warmCloudDepthToggle) {

    warmCloudDepthToggle.addEventListener(

        "change",

        async event => {

            activeOverlays.warmCloudDepth =
                event.target.checked;

            contourRenderGeneration++;

            resetNumericalCanvasTransforms();

            await renderContours();

            renderGeography();

            captureCanvasCamera();

        }

    );

}


/* =========================================================================================
   GEOPOTENTIAL HEIGHT TOGGLE EVENTS
   ========================================================================================= */

for (const config of GEOPOTENTIAL_HEIGHT_OVERLAYS) {

    const toggle =
        geopotentialHeightToggles[config.stateKey];

    if (!toggle) {
        continue;
    }

    toggle.addEventListener(
        "change",
        async event => {

            activeOverlays[config.stateKey] =
                event.target.checked;

            contourRenderGeneration++;

            resetNumericalCanvasTransforms();

            await renderContours();

            renderGeography();

            captureCanvasCamera();
        }
    );
}


/* =========================================================================================
   PRESSURE-LEVEL TEMPERATURE CONTOUR TOGGLE EVENTS
   ========================================================================================= */
for (const config of PRESSURE_TEMPERATURE_CONTOUR_OVERLAYS) {
    const toggle = pressureTemperatureContourToggles[config.stateKey];
    if (!toggle) continue;
    toggle.addEventListener("change", async event => {
        activeOverlays[config.stateKey] = event.target.checked;
        contourRenderGeneration++;
        resetNumericalCanvasTransforms();
        await renderContours();
        renderGeography();
        captureCanvasCamera();
        updateActiveLayersStrip();
    });
}


/* =========================================================================================
   FRONTOGENESIS CONTOUR TOGGLE EVENTS
   ========================================================================================= */
for (const config of FRONTOGENESIS_CONTOUR_OVERLAYS) {
    const toggle = frontogenesisContourToggles[config.stateKey];
    if (!toggle) continue;
    toggle.addEventListener("change", async event => {
        activeOverlays[config.stateKey] = event.target.checked;
        contourRenderGeneration++;
        resetNumericalCanvasTransforms();
        await renderContours();
        renderGeography();
        captureCanvasCamera();
        updateActiveLayersStrip();
    });
}


/* =========================================================================================
   LCL HEIGHT CONTOUR TOGGLE EVENTS
   ========================================================================================= */

for (const config of THERMODYNAMIC_CONTOUR_OVERLAYS) {

    const toggle =
        thermodynamicContourToggles[config.stateKey];

    if (!toggle) {
        continue;
    }

    toggle.addEventListener(
        "change",
        async event => {

            activeOverlays[config.stateKey] =
                event.target.checked;

            contourRenderGeneration++;

            resetNumericalCanvasTransforms();

            await renderContours();

            renderGeography();

            captureCanvasCamera();
        }
    );
}


/* =========================================================================================
   ACTIVE-LAYER STRIP EVENTS
   ========================================================================================= */

document.addEventListener(
    "change",
    () => {
        requestAnimationFrame(updateActiveLayersStrip);
    }
);

updateActiveLayersStrip();


/* =========================================================================================
   WINDOW RESIZE
   ========================================================================================= */

window.addEventListener(

    "resize",

    () => {

        invalidateNumericalRenders();


        resetNumericalCanvasTransforms();


        /*
         * Let MapLibre recalculate its viewport first.
         */
        map.resize();


        resizeAllCanvases();


        /*
         * map.resize() may also emit a map resize event, but render
         * generations prevent stale numerical results from replacing
         * newer ones.
         */
        renderAll();

    }

);


/* =========================================================================================
   INITIALIZE
   ========================================================================================= */

async function initialize() {

    bindTimelineControls();
    updateTimelineUi();

    try {

        if (statusElement) {

            statusElement.textContent =
                "Initializing...";

        }


        /*
         * Run metadata and static geography can load simultaneously.
         */
        await Promise.all([

            loadLatestRun(),

            loadGeography()

        ]);


        /*
         * The latest run may have changed since the previous page load.
         * Start with clean numerical caches.
         */
        resetNumericalTileCaches();


        /*
         * Read initial UI state.
         */
        if (fieldSelect) {

            activeField =
                fieldSelect.value ||
                "none";

        }


        if (citiesToggle) {

            citiesEnabled =
                citiesToggle.checked;

        }


        if (cwaBordersToggle) {

            cwaBordersEnabled =
                cwaBordersToggle.checked;

        }


        if (cwaBorderColorInput) {

            cwaBorderColor =
                cwaBorderColorInput.value ||
                cwaBorderColor;

        }


        for (const config of VECTOR_OVERLAY_CONFIG) {

            const toggle =
                vectorToggleElements[config.field] ||
                document.getElementById(config.toggleId);

            if (toggle) {
                activeOverlays[config.stateKey] =
                    toggle.checked;
            }

            const colorInput =
                vectorColorElements[config.field];

            vectorColors[config.field] =
                colorInput
                    ? colorInput.value
                    : (VECTOR_FIELDS[config.field].defaultColor || "#000000");
        }


        if (mslpToggle) {

            activeOverlays.mslp =
                mslpToggle.checked;

        }


        if (dcapeToggle) {

            activeOverlays.dcape =
                dcapeToggle.checked;

        }


        if (warmCloudDepthToggle) {

            activeOverlays.warmCloudDepth =
                warmCloudDepthToggle.checked;

        }


        for (const config of GEOPOTENTIAL_HEIGHT_OVERLAYS) {

            const toggle =
                geopotentialHeightToggles[config.stateKey];

            if (toggle) {
                activeOverlays[config.stateKey] =
                    toggle.checked;
            }

        }


        for (const config of PRESSURE_TEMPERATURE_CONTOUR_OVERLAYS) {
            const toggle = pressureTemperatureContourToggles[config.stateKey];
            if (toggle) activeOverlays[config.stateKey] = toggle.checked;
        }

        for (const config of FRONTOGENESIS_CONTOUR_OVERLAYS) {
            const toggle = frontogenesisContourToggles[config.stateKey];
            if (toggle) activeOverlays[config.stateKey] = toggle.checked;
        }

        for (const config of THERMODYNAMIC_CONTOUR_OVERLAYS) {

            const toggle =
                thermodynamicContourToggles[config.stateKey];

            if (toggle) {
                activeOverlays[config.stateKey] =
                    toggle.checked;
            }

        }


        updateLegend();


        resizeAllCanvases();


        /*
         * Initial geography can be shown immediately.
         */
        renderGeography();


        /*
         * Start with the selected sector.
         *
         * fitBounds generates map movement. The definitive numerical
         * render therefore occurs in moveend after the camera reaches
         * the requested sector.
         */
        const initialSector =
            sectorSelect &&
            sectorSelect.value
                ? sectorSelect.value
                : "lbf";


        fitSector(

            initialSector,

            {

                duration: 0

            }

        );


        /*
         * With duration 0, schedule one explicit render after MapLibre
         * has processed the camera update.
         */
        requestAnimationFrame(

            async () => {

                await renderAll();


                if (statusElement) {

                    statusElement.textContent =
                        `Loaded ${currentRun}`;

                }

                updateTimelineUi();
                scheduleAdjacentPreload();

            }

        );

    }
    catch (error) {

        console.error(
            "Initialization failed:",
            error
        );


        if (statusElement) {

            statusElement.textContent =
                `Initialization failed: ${error.message || "check network connection"}`;

        }

    }

}


/* =========================================================================================
   START APPLICATION
   ========================================================================================= */

map.on(

    "load",

    async () => {

        await initialize();

    }

);

/* Keep the active-layer description fitted to one line if the browser width changes. */
window.addEventListener("resize", () => {
    requestAnimationFrame(fitActiveLayersStrip);
});

/* =========================================================================================
   MAP ANNOTATION / FRONTAL ANALYSIS TOOLS
   ========================================================================================= */

const annotationCanvas = document.getElementById("annotation-canvas");
const annotationCtx = annotationCanvas ? annotationCanvas.getContext("2d") : null;
const drawingToolbar = document.getElementById("drawing-toolbar");
const drawColorInput = document.getElementById("draw-color");
const drawWidthInput = document.getElementById("draw-width");
const drawUndoButton = document.getElementById("draw-undo");
const drawClearButton = document.getElementById("draw-clear");
const savePngButton = document.getElementById("save-png");
const saveGifButton = document.getElementById("save-gif");
const drawHint = document.getElementById("draw-hint");

const ANNOTATION_STYLE = {
    cold:       { line: "#0047ff", width: 3.2, spacing: 38, size: 10 },
    warm:       { line: "#ed1010", width: 3.2, spacing: 38, size: 10 },
    stationary: { line: "#111111", width: 3.0, spacing: 40, size: 10 },
    occluded:   { line: "#8d009f", width: 3.2, spacing: 38, size: 10 },
    dryline:    { line: "#f28a00", width: 3.0, spacing: 34, size: 9 },
    trough:     { line: "#8b4a12", width: 3.0 }
};

let activeDrawingTool = "pan";
let annotations = [];
let currentAnnotation = null;
let annotationPointerId = null;

function resizeAnnotationCanvas() {
    if (!annotationCanvas || !annotationCtx) return;
    const rect = mapWrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (annotationCanvas.width !== w || annotationCanvas.height !== h) {
        annotationCanvas.width = w;
        annotationCanvas.height = h;
    }
    annotationCanvas.style.width = `${rect.width}px`;
    annotationCanvas.style.height = `${rect.height}px`;
    annotationCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    annotationCtx.lineCap = "round";
    annotationCtx.lineJoin = "round";
}

function setDrawingTool(tool) {
    activeDrawingTool = tool;
    document.querySelectorAll(".draw-tool[data-tool]").forEach(button => {
        button.classList.toggle("active", button.dataset.tool === tool);
    });
    if (annotationCanvas) {
        annotationCanvas.classList.toggle("drawing-active", tool !== "pan" && tool !== "eraser");
        annotationCanvas.classList.toggle("erasing-active", tool === "eraser");
    }
    if (drawHint) {
        const labels = {
            pan: "Pan mode", pen: "Drag to draw", cold: "Drag a cold front", warm: "Drag a warm front",
            stationary: "Drag a stationary front", occluded: "Drag an occluded front", dryline: "Drag a dryline",
            trough: "Drag a surface trough", high: "Click to place H", low: "Click to place L", eraser: "Click an annotation to erase"
        };
        drawHint.textContent = labels[tool] || "";
    }
    if (map && map.dragPan) {
        if (tool === "pan") map.dragPan.enable();
        else map.dragPan.disable();
    }
}

function eventLngLat(event) {
    const rect = annotationCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const ll = map.unproject([x, y]);
    return [ll.lng, ll.lat];
}

function annotationScreenPoints(annotation) {
    return (annotation.points || []).map(ll => {
        const p = map.project(ll);
        return { x: p.x, y: p.y };
    });
}

function drawSmoothPath(ctx, points) {
    if (!points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length === 1) return;
    if (points.length === 2) {
        ctx.lineTo(points[1].x, points[1].y);
        return;
    }
    for (let i = 1; i < points.length - 1; i++) {
        const midX = (points[i].x + points[i + 1].x) / 2;
        const midY = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
}

function resamplePolyline(points, spacing) {
    const out = [];
    if (points.length < 2) return out;
    let carry = spacing * 0.65;
    for (let i = 1; i < points.length; i++) {
        let ax = points[i - 1].x, ay = points[i - 1].y;
        const bx = points[i].x, by = points[i].y;
        let dx = bx - ax, dy = by - ay;
        let seg = Math.hypot(dx, dy);
        if (seg < 0.01) continue;
        const ux = dx / seg, uy = dy / seg;
        while (carry <= seg) {
            const x = ax + ux * carry, y = ay + uy * carry;
            out.push({ x, y, angle: Math.atan2(uy, ux) });
            ax = x; ay = y; seg -= carry;
            carry = spacing;
        }
        carry -= seg;
    }
    return out;
}

function drawTriangle(ctx, x, y, angle, side, size, color) {
    const nx = -Math.sin(angle) * side, ny = Math.cos(angle) * side;
    const tx = Math.cos(angle), ty = Math.sin(angle);
    const baseX = x + nx * 1.5, baseY = y + ny * 1.5;
    ctx.beginPath();
    ctx.moveTo(baseX - tx * size * 0.72, baseY - ty * size * 0.72);
    ctx.lineTo(baseX + tx * size * 0.72, baseY + ty * size * 0.72);
    ctx.lineTo(x + nx * size * 1.35, y + ny * size * 1.35);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
}

function drawSemicircle(ctx, x, y, angle, side, size, color, filled = true) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();

    /*
     * In screen coordinates (+y downward), the right side of a path points
     * toward +local-y.  Build the semicircle explicitly so side=+1 always
     * means the right-hand side of the direction the front was drawn.
     */
    const steps = 18;
    ctx.moveTo(-size, 0);
    for (let i = 0; i <= steps; i++) {
        const theta = Math.PI - (Math.PI * i / steps);
        const px = size * Math.cos(theta);
        const py = side * size * Math.sin(theta);
        ctx.lineTo(px, py);
    }
    ctx.closePath();

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    if (filled) {
        ctx.fillStyle = color;
        ctx.fill();
    }
    ctx.stroke();
    ctx.restore();
}


function renderFront(annotation, points) {
    const style = ANNOTATION_STYLE[annotation.type];
    if (!style || points.length < 2) return;
    annotationCtx.save();
    annotationCtx.strokeStyle = style.line;
    annotationCtx.lineWidth = style.width;
    annotationCtx.setLineDash(annotation.type === "trough" ? [11, 8] : []);
    drawSmoothPath(annotationCtx, points);
    annotationCtx.stroke();
    annotationCtx.setLineDash([]);
    if (annotation.type === "trough") { annotationCtx.restore(); return; }
    const marks = resamplePolyline(points, style.spacing);
    marks.forEach((mark, index) => {
        if (annotation.type === "cold") {
            drawTriangle(annotationCtx, mark.x, mark.y, mark.angle, -1, style.size, "#0047ff");
        } else if (annotation.type === "warm") {
            drawSemicircle(annotationCtx, mark.x, mark.y, mark.angle, -1, style.size, "#ed1010", true);
        } else if (annotation.type === "stationary") {
            if (index % 2 === 0) drawTriangle(annotationCtx, mark.x, mark.y, mark.angle, -1, style.size, "#0047ff");
            else drawSemicircle(annotationCtx, mark.x, mark.y, mark.angle, 1, style.size, "#ed1010", true);
        } else if (annotation.type === "occluded") {
            if (index % 2 === 0) drawTriangle(annotationCtx, mark.x, mark.y, mark.angle, -1, style.size, "#8d009f");
            else drawSemicircle(annotationCtx, mark.x, mark.y, mark.angle, -1, style.size, "#8d009f", true);
        } else if (annotation.type === "dryline") {
            drawSemicircle(annotationCtx, mark.x, mark.y, mark.angle, -1, style.size, "#f28a00", true);
        }
    });
    annotationCtx.restore();
}

function renderAnnotation(annotation) {
    if (!annotationCtx) return;
    if (annotation.type === "high" || annotation.type === "low") {
        const p = map.project(annotation.points[0]);
        annotationCtx.save();
        annotationCtx.font = '800 58px Inter, "Segoe UI", Arial, sans-serif';
        annotationCtx.textAlign = "center";
        annotationCtx.textBaseline = "middle";
        annotationCtx.lineWidth = 3;
        annotationCtx.strokeStyle = "rgba(255,255,255,.9)";
        annotationCtx.fillStyle = annotation.type === "high" ? "#003cff" : "#ed0000";
        const letter = annotation.type === "high" ? "H" : "L";
        annotationCtx.strokeText(letter, p.x, p.y);
        annotationCtx.fillText(letter, p.x, p.y);
        annotationCtx.restore();
        return;
    }
    const points = annotationScreenPoints(annotation);
    if (annotation.type === "pen") {
        annotationCtx.save();
        annotationCtx.strokeStyle = annotation.color || "#ff3030";
        annotationCtx.lineWidth = annotation.width || 4;
        drawSmoothPath(annotationCtx, points);
        annotationCtx.stroke();
        annotationCtx.restore();
        return;
    }
    renderFront(annotation, points);
}

function renderAnnotations() {
    if (!annotationCanvas || !annotationCtx) return;
    resizeAnnotationCanvas();
    const rect = mapWrapper.getBoundingClientRect();
    annotationCtx.clearRect(0, 0, rect.width, rect.height);
    annotations.forEach(renderAnnotation);
    if (currentAnnotation) renderAnnotation(currentAnnotation);
}

function pointSegmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (!len2) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function annotationDistance(annotation, x, y) {
    const pts = annotationScreenPoints(annotation);
    if (!pts.length) return Infinity;
    if (annotation.type === "high" || annotation.type === "low") return Math.hypot(x - pts[0].x, y - pts[0].y);
    let best = Infinity;
    for (let i = 1; i < pts.length; i++) best = Math.min(best, pointSegmentDistance(x, y, pts[i-1].x, pts[i-1].y, pts[i].x, pts[i].y));
    return best;
}

function eraseAt(event) {
    const rect = annotationCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    let bestIndex = -1, bestDistance = 18;
    annotations.forEach((a, i) => {
        const d = annotationDistance(a, x, y);
        if (d < bestDistance) { bestDistance = d; bestIndex = i; }
    });
    if (bestIndex >= 0) {
        annotations.splice(bestIndex, 1);
        renderAnnotations();
    }
}


/* =========================================================================================
   4K PNG EXPORT
   ========================================================================================= */

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportFileTimeStamp(value) {
    const d = value ? new Date(value) : new Date();
    if (Number.isNaN(d.getTime())) return "analysis";
    const p = n => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}Z`;
}

async function saveCurrentMapPng4k() {
    if (!map || !mapWrapper) return;

    const oldText = savePngButton ? savePngButton.textContent : "";
    if (savePngButton) {
        savePngButton.disabled = true;
        savePngButton.textContent = "Preparing…";
    }

    try {
        renderAnnotations();
        if (statusElement) statusElement.textContent = "Preparing PNG...";
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        const rect = mapWrapper.getBoundingClientRect();
        const srcW = Math.max(1, Math.round(rect.width));
        const srcH = Math.max(1, Math.round(rect.height));

        /* 4K-width export while preserving the exact current map aspect ratio. */
        const outW = 3840;
        const headerH = 92;
        const footerH = 118;
        const mapH = Math.max(1, Math.round(outW * srcH / srcW));
        const outH = headerH + mapH + footerH;
        const exportScale = outW / srcW;

        const out = document.createElement("canvas");
        out.width = outW;
        out.height = outH;
        const ctx = out.getContext("2d", { alpha: false });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, outW, outH);

        /* Compact one-line export header. */
        ctx.fillStyle = "#102433";
        ctx.fillRect(0, 0, outW, headerH);
        ctx.textBaseline = "middle";

        /* Left: clearly credits the visualization/viewer, not the source data. */
        ctx.textAlign = "left";
        ctx.fillStyle = "#d7e7f2";
        ctx.font = '600 25px Inter, "Segoe UI", Arial, sans-serif';
        ctx.fillText("Visualization & Viewer Developed by: Matthew Labenz · NWS North Platte, NE", 42, headerH / 2);

        /* Right: product/data title only. Valid time remains in the footer strip. */
        ctx.textAlign = "right";
        ctx.fillStyle = "#ffffff";
        ctx.font = '700 29px Inter, "Segoe UI", Arial, sans-serif';
        ctx.fillText("3-km Mesoscale Analysis Data", outW - 42, headerH / 2);
        ctx.textAlign = "left";

        const mapY = headerH;
        const layers = [
            map.getCanvas(),
            weatherCanvas,
            vectorCanvas,
            contourCanvas,
            geographyCanvas,
            contourLabelCanvas,
            annotationCanvas
        ].filter(Boolean);

        for (const layer of layers) {
            ctx.drawImage(layer, 0, 0, layer.width, layer.height, 0, mapY, outW, mapH);
        }

        /*
         * Export the legend with the SAME proportions and placement it has in
         * the live viewer.  This deliberately avoids maintaining a second,
         * export-only legend design.
         */
        if (legend && legend.style.display !== "none" && activeField && activeField !== "none") {
            const legendRect = legend.getBoundingClientRect();
            const cardX = Math.round((legendRect.left - rect.left) * exportScale);
            const cardY = Math.round(mapY + (legendRect.top - rect.top) * exportScale);
            const cardW = Math.round(legendRect.width * exportScale);
            const cardH = Math.round(legendRect.height * exportScale);
            const padX = Math.max(22, Math.round(14 * exportScale));
            const padTop = Math.max(18, Math.round(11 * exportScale));
            const titleFont = Math.max(20, Math.round(12 * exportScale));
            const labelFont = Math.max(16, Math.round(10 * exportScale));
            const barH = Math.max(30, Math.round(18 * exportScale));
            const titleY = cardY + padTop + titleFont * 0.45;
            const barY = titleY + Math.round(12 * exportScale) + titleFont * 0.55;
            const innerX = cardX + padX;
            const innerW = cardW - padX * 2;
            const labelY = Math.min(cardY + cardH - Math.round(10 * exportScale), barY + barH + Math.round(16 * exportScale));

            ctx.fillStyle = "rgba(20,40,57,.96)";
            ctx.fillRect(cardX, cardY, cardW, cardH);
            ctx.strokeStyle = "#41647d";
            ctx.lineWidth = Math.max(2, Math.round(exportScale));
            ctx.strokeRect(cardX, cardY, cardW, cardH);

            ctx.fillStyle = "#f4f8fb";
            ctx.font = `600 ${titleFont}px Inter, "Segoe UI", Arial, sans-serif`;
            ctx.textAlign = "left";
            ctx.fillText(legendTitle ? legendTitle.textContent : "", innerX, titleY);

            if (legendCanvas && legendCanvas.width && legendCanvas.height) {
                ctx.drawImage(legendCanvas, innerX, barY, innerW, barH);
            }

            if (legendLabels) {
                const labels = Array.from(legendLabels.querySelectorAll(".legend-label"));
                ctx.font = `500 ${labelFont}px Inter, "Segoe UI", Arial, sans-serif`;
                ctx.fillStyle = "#c7d6e1";
                const labelsRect = legendLabels.getBoundingClientRect();
                labels.forEach((el, i) => {
                    const elRect = el.getBoundingClientRect();

                    // Preserve the exact anchor position used by the live DOM legend.
                    // First/last labels are edge-anchored; interior labels are centered.
                    let liveAnchorX;
                    if (el.classList.contains("legend-label-first")) {
                        liveAnchorX = elRect.left;
                        ctx.textAlign = "left";
                    }
                    else if (el.classList.contains("legend-label-last")) {
                        liveAnchorX = elRect.right;
                        ctx.textAlign = "right";
                    }
                    else {
                        liveAnchorX = elRect.left + elRect.width / 2;
                        ctx.textAlign = "center";
                    }

                    const livePct = labelsRect.width > 0
                        ? (liveAnchorX - labelsRect.left) / labelsRect.width
                        : 0;
                    const x = innerX + livePct * innerW;
                    ctx.fillText(el.textContent || "", x, labelY);
                });
                ctx.textAlign = "left";
            }
        }

        /* Footer / active-layer strip.  Keep vector-color indicators in PNG. */
        const footerY = headerH + mapH;
        ctx.fillStyle = "#f7f8fa";
        ctx.fillRect(0, footerY, outW, footerH);
        ctx.strokeStyle = "#aeb7bf";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, footerY + 1);
        ctx.lineTo(outW, footerY + 1);
        ctx.stroke();

        const descriptions = getActiveLayerDescriptions();
        const items = [
            ...descriptions.map(item => ({ ...item })),
            { text: `Valid: ${formatAnalysisTime(currentAnalysisTime)}`, color: null }
        ];

        ctx.font = '650 29px Inter, "Segoe UI", Arial, sans-serif';
        ctx.textBaseline = "middle";
        const separator = "   |   ";
        const indicatorW = 34;
        const indicatorGap = 12;
        const indicatorLineW = 7;

        const widths = items.map(item => {
            const textW = ctx.measureText(item.text).width;
            return textW + (item.color ? indicatorW + indicatorGap : 0);
        });
        const sepW = ctx.measureText(separator).width;
        const totalW = widths.reduce((a, b) => a + b, 0) + sepW * Math.max(0, items.length - 1);
        let x = Math.max(50, (outW - totalW) / 2);
        const y = footerY + 43;

        items.forEach((item, index) => {
            if (item.color) {
                ctx.strokeStyle = item.color;
                ctx.lineWidth = indicatorLineW;
                ctx.lineCap = "round";
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x + indicatorW, y);
                ctx.stroke();
                ctx.lineCap = "butt";
                x += indicatorW + indicatorGap;
            }

            ctx.fillStyle = "#17232d";
            ctx.textAlign = "left";
            ctx.fillText(item.text, x, y);
            x += ctx.measureText(item.text).width;

            if (index < items.length - 1) {
                ctx.fillStyle = "#8b969f";
                ctx.fillText(separator, x, y);
                x += sepW;
            }
        });
        ctx.textAlign = "left";

        /* Secondary credit stays in the white footer so the navy header remains compact. */
        ctx.fillStyle = "#66727c";
        ctx.font = '500 21px Inter, "Segoe UI", Arial, sans-serif';
        ctx.textAlign = "center";
        ctx.fillText("Credit: John Stoppkotte, SOO · NWS North Platte, NE", outW / 2, footerY + 88);
        ctx.textAlign = "left";

        const blob = await new Promise(resolve => out.toBlob(resolve, "image/png"));
        if (!blob) throw new Error("PNG encoding failed.");
        downloadBlob(blob, `3km_Mesoscale_Analysis_${exportFileTimeStamp(currentAnalysisTime)}.png`);
        if (statusElement) statusElement.textContent = "PNG saved";
    } catch (error) {
        console.error("4K PNG export failed:", error);
        if (statusElement) statusElement.textContent = "PNG export failed";
    } finally {
        if (savePngButton) {
            savePngButton.disabled = false;
            savePngButton.textContent = oldText || "Save PNG";
        }
    }
}
if (savePngButton) {
    savePngButton.addEventListener("click", saveCurrentMapPng4k);
}


/* =========================================================================================
   GIF EXPORT
   ========================================================================================= */

async function buildGifFrameCanvas(outW = 1920) {
    renderAnnotations();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const rect = mapWrapper.getBoundingClientRect();
    const srcW = Math.max(1, Math.round(rect.width));
    const srcH = Math.max(1, Math.round(rect.height));

    /* GIF frame width while preserving the exact current map aspect ratio. */
    // Match the PNG export layout exactly, scaled from the 3840px PNG baseline.
    const layoutScale = outW / 3840;
    const headerH = Math.max(1, Math.round(92 * layoutScale));
    const footerH = Math.max(1, Math.round(118 * layoutScale));
    const mapH = Math.max(1, Math.round(outW * srcH / srcW));
    const outH = headerH + mapH + footerH;
    const exportScale = outW / srcW;

    const out = document.createElement("canvas");
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext("2d", { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outW, outH);

    /* Compact one-line export header. */
    ctx.fillStyle = "#102433";
    ctx.fillRect(0, 0, outW, headerH);
    ctx.textBaseline = "middle";

    /* Left: clearly credits the visualization/viewer, not the source data. */
    ctx.textAlign = "left";
    ctx.fillStyle = "#d7e7f2";
    ctx.font = `600 ${Math.max(1, Math.round(25 * layoutScale))}px Inter, \"Segoe UI\", Arial, sans-serif`;
    ctx.fillText("Visualization & Viewer Developed by: Matthew Labenz · NWS North Platte, NE", Math.round(42 * layoutScale), headerH / 2);

    /* Right: product/data title only. Valid time remains in the footer strip. */
    ctx.textAlign = "right";
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${Math.max(1, Math.round(29 * layoutScale))}px Inter, \"Segoe UI\", Arial, sans-serif`;
    ctx.fillText("3-km Mesoscale Analysis Data", outW - Math.round(42 * layoutScale), headerH / 2);
    ctx.textAlign = "left";

    const mapY = headerH;
    const layers = [
        map.getCanvas(),
        weatherCanvas,
        vectorCanvas,
        contourCanvas,
        geographyCanvas,
        contourLabelCanvas,
        annotationCanvas
    ].filter(Boolean);

    for (const layer of layers) {
        ctx.drawImage(layer, 0, 0, layer.width, layer.height, 0, mapY, outW, mapH);
    }

    /*
     * Export the legend with the SAME proportions and placement it has in
     * the live viewer.  This deliberately avoids maintaining a second,
     * export-only legend design.
     */
    if (legend && legend.style.display !== "none" && activeField && activeField !== "none") {
        const legendRect = legend.getBoundingClientRect();
        const cardX = Math.round((legendRect.left - rect.left) * exportScale);
        const cardY = Math.round(mapY + (legendRect.top - rect.top) * exportScale);
        const cardW = Math.round(legendRect.width * exportScale);
        const cardH = Math.round(legendRect.height * exportScale);
        const pngScale = 3840 / srcW;
        const padX = Math.max(1, Math.round(Math.max(22, 14 * pngScale) * layoutScale));
        const padTop = Math.max(1, Math.round(Math.max(18, 11 * pngScale) * layoutScale));
        const titleFont = Math.max(1, Math.round(Math.max(20, 12 * pngScale) * layoutScale));
        const labelFont = Math.max(1, Math.round(Math.max(16, 10 * pngScale) * layoutScale));
        const barH = Math.max(1, Math.round(Math.max(30, 18 * pngScale) * layoutScale));
        const titleY = cardY + padTop + titleFont * 0.45;
        const barY = titleY + Math.round(12 * pngScale * layoutScale) + titleFont * 0.55;
        const innerX = cardX + padX;
        const innerW = cardW - padX * 2;
        const labelY = Math.min(cardY + cardH - Math.round(10 * pngScale * layoutScale), barY + barH + Math.round(16 * pngScale * layoutScale));

        ctx.fillStyle = "rgba(20,40,57,.96)";
        ctx.fillRect(cardX, cardY, cardW, cardH);
        ctx.strokeStyle = "#41647d";
        ctx.lineWidth = Math.max(1, Math.round(Math.max(2, 3840 / srcW) * layoutScale));
        ctx.strokeRect(cardX, cardY, cardW, cardH);

        ctx.fillStyle = "#f4f8fb";
        ctx.font = `600 ${titleFont}px Inter, "Segoe UI", Arial, sans-serif`;
        ctx.textAlign = "left";
        ctx.fillText(legendTitle ? legendTitle.textContent : "", innerX, titleY);

        if (legendCanvas && legendCanvas.width && legendCanvas.height) {
            ctx.drawImage(legendCanvas, innerX, barY, innerW, barH);
        }

        if (legendLabels) {
            const labels = Array.from(legendLabels.querySelectorAll(".legend-label"));
            ctx.font = `500 ${labelFont}px Inter, "Segoe UI", Arial, sans-serif`;
            ctx.fillStyle = "#c7d6e1";
            const labelsRect = legendLabels.getBoundingClientRect();
            labels.forEach((el, i) => {
                const elRect = el.getBoundingClientRect();

                // Preserve the exact anchor position used by the live DOM legend.
                // First/last labels are edge-anchored; interior labels are centered.
                let liveAnchorX;
                if (el.classList.contains("legend-label-first")) {
                    liveAnchorX = elRect.left;
                    ctx.textAlign = "left";
                }
                else if (el.classList.contains("legend-label-last")) {
                    liveAnchorX = elRect.right;
                    ctx.textAlign = "right";
                }
                else {
                    liveAnchorX = elRect.left + elRect.width / 2;
                    ctx.textAlign = "center";
                }

                const livePct = labelsRect.width > 0
                    ? (liveAnchorX - labelsRect.left) / labelsRect.width
                    : 0;
                const x = innerX + livePct * innerW;
                ctx.fillText(el.textContent || "", x, labelY);
            });
            ctx.textAlign = "left";
        }
    }

    /* Footer / active-layer strip.  Keep vector-color indicators in PNG. */
    const footerY = headerH + mapH;
    ctx.fillStyle = "#f7f8fa";
    ctx.fillRect(0, footerY, outW, footerH);
    ctx.strokeStyle = "#aeb7bf";
    ctx.lineWidth = Math.max(1, Math.round(2 * layoutScale));
    ctx.beginPath();
    ctx.moveTo(0, footerY + 1);
    ctx.lineTo(outW, footerY + 1);
    ctx.stroke();

    const descriptions = getActiveLayerDescriptions();
    const items = [
        ...descriptions.map(item => ({ ...item })),
        { text: `Valid: ${formatAnalysisTime(currentAnalysisTime)}`, color: null }
    ];

    ctx.font = `650 ${Math.max(1, Math.round(29 * layoutScale))}px Inter, \"Segoe UI\", Arial, sans-serif`;
    ctx.textBaseline = "middle";
    const separator = "   |   ";
    const indicatorW = Math.max(1, Math.round(34 * layoutScale));
    const indicatorGap = Math.max(1, Math.round(12 * layoutScale));
    const indicatorLineW = Math.max(1, Math.round(7 * layoutScale));

    const widths = items.map(item => {
        const textW = ctx.measureText(item.text).width;
        return textW + (item.color ? indicatorW + indicatorGap : 0);
    });
    const sepW = ctx.measureText(separator).width;
    const totalW = widths.reduce((a, b) => a + b, 0) + sepW * Math.max(0, items.length - 1);
    let x = Math.max(Math.round(50 * layoutScale), (outW - totalW) / 2);
    const y = footerY + Math.round(43 * layoutScale);

    items.forEach((item, index) => {
        if (item.color) {
            ctx.strokeStyle = item.color;
            ctx.lineWidth = indicatorLineW;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + indicatorW, y);
            ctx.stroke();
            ctx.lineCap = "butt";
            x += indicatorW + indicatorGap;
        }

        ctx.fillStyle = "#17232d";
        ctx.textAlign = "left";
        ctx.fillText(item.text, x, y);
        x += ctx.measureText(item.text).width;

        if (index < items.length - 1) {
            ctx.fillStyle = "#8b969f";
            ctx.fillText(separator, x, y);
            x += sepW;
        }
    });
    ctx.textAlign = "left";

    /* Secondary credit stays in the white footer so the navy header remains compact. */
    ctx.fillStyle = "#66727c";
    ctx.font = `500 ${Math.max(1, Math.round(21 * layoutScale))}px Inter, \"Segoe UI\", Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("Credit: John Stoppkotte, SOO · NWS North Platte, NE", outW / 2, footerY + Math.round(88 * layoutScale));
    ctx.textAlign = "left";

    return out;
}

async function getGifWorkerUrl() {
    const workerSourceUrl = "https://cdn.jsdelivr.net/npm/gif.js.optimized@1.0.1/dist/gif.worker.js";
    const response = await fetch(workerSourceUrl, { mode: "cors" });
    if (!response.ok) throw new Error(`Could not load GIF worker (${response.status}).`);
    const source = await response.text();
    return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

async function saveTimelineGif() {
    if (!map || !mapWrapper || typeof GIF === "undefined") {
        if (statusElement) statusElement.textContent = "GIF encoder unavailable";
        return;
    }

    const oldText = saveGifButton ? saveGifButton.textContent : "";
    const originalRun = currentRun;
    const originalPlaying = timelineState.playing;
    const runs = filteredTimelineRuns();
    if (!runs.length) return;

    let workerUrl = null;
    setPlaying(false);
    if (saveGifButton) {
        saveGifButton.disabled = true;
        saveGifButton.textContent = "Preparing…";
    }
    if (savePngButton) savePngButton.disabled = true;

    try {
        workerUrl = await getGifWorkerUrl();
        const gif = new GIF({
            workers: 2,
            quality: 1,
            dither: "FloydSteinberg-serpentine",
            repeat: 0,
            workerScript: workerUrl
        });

        const normalDelay = Math.max(120, Math.round(PLAYBACK_BASE_MS / timelineState.playbackSpeed));
        const newestDelay = Math.round(normalDelay * 1.45);

        for (let i = 0; i < runs.length; i++) {
            const item = runs[i];
            if (statusElement) statusElement.textContent = `GIF frame ${i + 1} of ${runs.length}: ${formatTimelineUtc(item.analysis_time || runIdToIso(item.run))}`;
            if (saveGifButton) saveGifButton.textContent = `${i + 1}/${runs.length}`;

            const ok = await applyRun(item, { render: true, preload: false });
            if (!ok) throw new Error(`Could not render ${item.run}.`);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

            const frameCanvas = await buildGifFrameCanvas(1920);
            gif.addFrame(frameCanvas, {
                copy: true,
                delay: item.run === timelineState.latestRun ? newestDelay : normalDelay
            });
        }

        if (statusElement) statusElement.textContent = "Encoding GIF...";
        if (saveGifButton) saveGifButton.textContent = "Encoding…";

        const gifBlob = await new Promise((resolve, reject) => {
            gif.on("finished", resolve);
            gif.on("abort", () => reject(new Error("GIF encoding aborted.")));
            gif.render();
        });

        const firstTime = runs[0]?.analysis_time || runIdToIso(runs[0]?.run);
        const lastTime = runs.at(-1)?.analysis_time || runIdToIso(runs.at(-1)?.run);
        downloadBlob(gifBlob, `3km_Mesoscale_Analysis_${exportFileTimeStamp(firstTime)}_to_${exportFileTimeStamp(lastTime)}.gif`);
        if (statusElement) statusElement.textContent = `GIF saved (${runs.length} frames)`;
    } catch (error) {
        console.error("GIF export failed:", error);
        if (statusElement) statusElement.textContent = "GIF export failed";
    } finally {
        if (originalRun && currentRun !== originalRun) {
            const originalItem = timelineState.availableRuns.find(item => item.run === originalRun);
            if (originalItem) await applyRun(originalItem, { render: true, preload: true });
        }
        if (workerUrl) URL.revokeObjectURL(workerUrl);
        if (saveGifButton) {
            saveGifButton.disabled = false;
            saveGifButton.textContent = oldText || "Save GIF";
        }
        if (savePngButton) savePngButton.disabled = false;
        if (originalPlaying) setPlaying(true);
    }
}

if (saveGifButton) {
    saveGifButton.addEventListener("click", saveTimelineGif);
}

if (drawingToolbar && annotationCanvas) {
    drawingToolbar.querySelectorAll(".draw-tool[data-tool]").forEach(button => {
        button.addEventListener("click", () => setDrawingTool(button.dataset.tool));
    });

    annotationCanvas.addEventListener("pointerdown", event => {
        if (activeDrawingTool === "pan") return;
        event.preventDefault();
        if (activeDrawingTool === "eraser") {
            eraseAt(event);
            setTimeout(() => {
                if (typeof window.__mpSendAnnotationState === "function") window.__mpSendAnnotationState();
            }, 0);
            return;
        }
        const ll = eventLngLat(event);
        if (activeDrawingTool === "high" || activeDrawingTool === "low") {
            annotations.push({ type: activeDrawingTool, points: [ll] });
            renderAnnotations();
            setTimeout(() => {
                if (typeof window.__mpSendAnnotationState === "function") window.__mpSendAnnotationState();
            }, 0);
            return;
        }
        annotationPointerId = event.pointerId;
        annotationCanvas.setPointerCapture(event.pointerId);
        currentAnnotation = {
            type: activeDrawingTool,
            points: [ll],
            color: drawColorInput ? drawColorInput.value : "#ff3030",
            width: drawWidthInput ? Math.max(1, Math.min(12, Number(drawWidthInput.value) || 4)) : 4
        };
        renderAnnotations();
    });

    annotationCanvas.addEventListener("pointermove", event => {
        if (!currentAnnotation || event.pointerId !== annotationPointerId) return;
        event.preventDefault();
        const ll = eventLngLat(event);
        const last = currentAnnotation.points[currentAnnotation.points.length - 1];
        const lp = map.project(last), np = map.project(ll);
        if (Math.hypot(np.x - lp.x, np.y - lp.y) >= 3) {
            currentAnnotation.points.push(ll);
            renderAnnotations();
        }
    });

    const finishAnnotation = event => {
        if (!currentAnnotation || event.pointerId !== annotationPointerId) return;
        event.preventDefault();
        if (currentAnnotation.points.length >= 2) annotations.push(currentAnnotation);
        currentAnnotation = null;
        annotationPointerId = null;
        try { annotationCanvas.releasePointerCapture(event.pointerId); } catch (_) {}
        renderAnnotations();
        setTimeout(() => {
            if (typeof window.__mpSendAnnotationState === "function") window.__mpSendAnnotationState();
        }, 0);
    };
    annotationCanvas.addEventListener("pointerup", finishAnnotation);
    annotationCanvas.addEventListener("pointercancel", finishAnnotation);
}

if (drawUndoButton) drawUndoButton.addEventListener("click", () => {
    if (annotations.length) annotations.pop();
    renderAnnotations();
});

if (drawClearButton) drawClearButton.addEventListener("click", () => {
    annotations = [];
    currentAnnotation = null;
    renderAnnotations();
});

/* Keep annotations geographically anchored during map navigation and resizing. */
map.on("move", renderAnnotations);
map.on("zoom", renderAnnotations);
map.on("resize", renderAnnotations);
window.addEventListener("resize", () => requestAnimationFrame(renderAnnotations));

setDrawingTool("pan");
requestAnimationFrame(renderAnnotations);


/* Timeline manifest refresh is intentionally lightweight; tiles remain demand-loaded. */
setInterval(refreshAvailableTimes, LIVE_MANIFEST_REFRESH_MS);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden && currentRun) refreshAvailableTimes();
});

/* =========================================================================================
   MULTI-PANEL CHILD BRIDGE
   ========================================================================================= */
(function initMultiPanelChildBridge() {
    const panelNumber = Number(__MP_PARAMS.get("panel") || 1);
    let applyingRemoteCamera = false;

    function notify(type, extra = {}) {
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type, panel: panelNumber, ...extra }, "*");
        }
    }

    // Only a normal pan-mode click may change the active panel.
    // While any drawing/eraser tool is active, pointer events belong to the
    // annotation canvas and must not switch the sidebar to another panel.
    document.addEventListener("pointerdown", event => {
        if (activeDrawingTool !== "pan") return;
        notify("mp-activate");
    }, true);

    map.on("moveend", () => {
        if (applyingRemoteCamera) return;
        const c = map.getCenter();
        notify("mp-camera", { camera: { center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() } });
    });

    window.addEventListener("message", event => {
        const msg = event.data || {};
        if (msg.type === "mp-set-camera" && msg.camera) {
            applyingRemoteCamera = true;
            try { map.jumpTo(msg.camera); } finally { setTimeout(() => { applyingRemoteCamera = false; }, 120); }
        } else if (msg.type === "mp-layout") {
            document.body.classList.remove("mp-layout-1", "mp-layout-2", "mp-layout-4");
            document.body.classList.add(`mp-layout-${Number(msg.count) === 4 ? 4 : Number(msg.count) === 2 ? 2 : 1}`);
            requestAnimationFrame(() => { updateLegend(); map.resize(); resizeAllCanvases(); renderAnnotations(); });
        } else if (msg.type === "mp-set-annotations" && Array.isArray(msg.annotations)) {
            window.__mpSetAnnotations(msg.annotations);
        } else if (msg.type === "mp-resize") {
            requestAnimationFrame(() => { map.resize(); resizeAllCanvases(); renderAnnotations(); });
        }
    });

    function cloneAnnotationState() {
        const source = currentAnnotation ? [...annotations, currentAnnotation] : annotations;
        return source.map(a => ({
            ...a,
            points: Array.isArray(a.points) ? a.points.map(p => ({ lng: Number(p.lng), lat: Number(p.lat) })) : []
        }));
    }

    window.__mpSetAnnotations = function(annotationData) {
        if (!Array.isArray(annotationData)) return;
        annotations = annotationData.map(a => ({
            ...a,
            points: Array.isArray(a.points) ? a.points.map(p => ({ lng: Number(p.lng), lat: Number(p.lat) })) : []
        }));
        currentAnnotation = null;
        renderAnnotations();
    };

    window.__mpGetAnnotations = function() {
        return cloneAnnotationState();
    };
    window.__mpProject = function(ll) {
        const p = map.project(ll);
        return { x: p.x, y: p.y };
    };
    window.__mpUnproject = function(x, y) {
        const ll = map.unproject([x, y]);
        return [ll.lng, ll.lat];
    };
    window.__mpMapSize = function() {
        const r = mapWrapper.getBoundingClientRect();
        return { width: r.width, height: r.height };
    };

    function sendAnnotationState() {
        const data = cloneAnnotationState();
        // Direct same-origin route is the primary path.
        try {
            if (window.parent && window.parent !== window &&
                typeof window.parent.__mpReceiveAnnotations === "function") {
                window.parent.__mpReceiveAnnotations(panelNumber, data);
                return;
            }
        } catch (_) {}
        // Fallback for environments where direct parent access is unavailable.
        notify("mp-annotations", { annotations: data });
    }

    window.__mpSendAnnotationState = sendAnnotationState;

    let annotationSyncQueued = false;
    annotationCanvas.addEventListener("pointermove", () => {
        if (!currentAnnotation || annotationSyncQueued) return;
        annotationSyncQueued = true;
        requestAnimationFrame(() => {
            annotationSyncQueued = false;
            sendAnnotationState();
        });
    });

    if (drawUndoButton) drawUndoButton.addEventListener("click", () => setTimeout(sendAnnotationState, 0));
    if (drawClearButton) drawClearButton.addEventListener("click", () => setTimeout(sendAnnotationState, 0));

    window.__mpCapturePanel = async function(outW = 1800) {
        renderAnnotations();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rect = mapWrapper.getBoundingClientRect();
        const srcW = Math.max(1, rect.width), srcH = Math.max(1, rect.height);
        const footerH = 72;
        const outH = Math.round(outW * srcH / srcW) + footerH;
        const out = document.createElement("canvas"); out.width = outW; out.height = outH;
        const ctx = out.getContext("2d", { alpha: false });
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, outW, outH);
        const mapH = outH - footerH;
        const layers = [map.getCanvas(), weatherCanvas, vectorCanvas, contourCanvas, geographyCanvas, contourLabelCanvas, annotationCanvas].filter(Boolean);
        for (const layer of layers) ctx.drawImage(layer, 0, 0, layer.width, layer.height, 0, 0, outW, mapH);

        if (legend && legend.style.display !== "none") {
            /*
             * PNG legend is rendered independently from the compact on-screen
             * multi-panel legend.  Do NOT scale the tiny DOM legend box up:
             * that was squeezing the color ramp and piling the tick labels
             * together in 2/4-panel exports.
             */
            const lr = legend.getBoundingClientRect();
            const scale = outW / srcW;

            // Preserve the legend's map-relative lower-left position, but give
            // the exported legend a stable width/height in output pixels.
            const leftFrac = Math.max(0, (lr.left - rect.left) / srcW);
            const bottomFrac = Math.max(0, (rect.bottom - lr.bottom) / srcH);

            const w = Math.round(Math.max(470, Math.min(620, outW * 0.30)));
            const h = 118;
            const x = Math.max(18, Math.min(outW - w - 18, Math.round(leftFrac * outW)));
            const y = Math.max(18, Math.min(mapH - h - 18, Math.round(mapH - bottomFrac * mapH - h)));

            const padX = 22;
            const titleY = y + 29;
            const barX = x + padX;
            const barY = y + 43;
            const barW = w - padX * 2;
            const barH = 22;
            const labelY = barY + barH + 27;

            ctx.fillStyle = "rgba(20,40,57,.96)";
            ctx.fillRect(x, y, w, h);
            ctx.strokeStyle = "#41647d";
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, w, h);

            ctx.fillStyle = "#f4f8fb";
            ctx.font = '600 21px Inter, Arial, sans-serif';
            ctx.textAlign = "left";
            ctx.textBaseline = "alphabetic";
            ctx.fillText(legendTitle?.textContent || "", x + padX, titleY);

            if (legendCanvas && legendCanvas.width) {
                ctx.drawImage(legendCanvas, barX, barY, barW, barH);
            }

            if (legendLabels) {
                const allLabels = Array.from(legendLabels.querySelectorAll(".legend-label"))
                    .map(el => {
                        const rawPct = parseFloat(el.style.left || "");
                        return {
                            el,
                            pct: Number.isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) / 100 : null,
                            text: (el.textContent || "").trim()
                        };
                    })
                    .filter(d => d.pct !== null && d.text);

                // Thin only when labels would collide at export resolution.
                // Endpoints are always preserved.
                ctx.font = '500 17px Inter, Arial, sans-serif';
                const minGap = 58;
                const kept = [];
                allLabels.forEach((d, i) => {
                    const px = barX + d.pct * barW;
                    if (i === 0 || i === allLabels.length - 1) {
                        kept.push({ ...d, px });
                        return;
                    }
                    const prev = kept[kept.length - 1];
                    const lastPx = barX + allLabels[allLabels.length - 1].pct * barW;
                    if ((!prev || px - prev.px >= minGap) && lastPx - px >= minGap) {
                        kept.push({ ...d, px });
                    }
                });

                // If the final endpoint was already inserted early, de-dupe.
                const unique = [];
                kept.sort((a,b) => a.pct - b.pct).forEach(d => {
                    if (!unique.length || Math.abs(d.pct - unique[unique.length-1].pct) > 1e-6) unique.push(d);
                });

                ctx.fillStyle = "#c7d6e1";
                ctx.textBaseline = "alphabetic";
                unique.forEach((d, i) => {
                    ctx.textAlign = i === 0 ? "left" : i === unique.length - 1 ? "right" : "center";
                    ctx.fillText(d.text, d.px, labelY);
                });
            }
        }

        ctx.fillStyle = "#f7f8fa"; ctx.fillRect(0, mapH, outW, footerH);
        ctx.strokeStyle = "#aeb7bf"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0,mapH+.5); ctx.lineTo(outW,mapH+.5); ctx.stroke();
        ctx.fillStyle = "#17232d"; ctx.font = '650 22px Inter, "Segoe UI", Arial, sans-serif'; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        const footerText = document.getElementById("active-layers-text")?.textContent || `Valid: ${formatAnalysisTime(currentAnalysisTime)}`;
        let text = footerText.replace(/\s*\|\s*/g, " | ").replace(/\s+/g, " ").trim();
        while (ctx.measureText(text).width > outW - 70 && text.length > 20) text = text.slice(0, -4) + "…";
        ctx.fillText(text, outW/2, mapH + footerH/2);
        return out.toDataURL("image/png");
    };

    map.once("idle", () => notify("mp-ready"));
    setTimeout(() => notify("mp-ready"), 2500);
})();
}

