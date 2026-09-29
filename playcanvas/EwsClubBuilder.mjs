import { Script } from 'playcanvas';

/**
 * EWS SESSIONS 3.0 — procedural club foundation.
 *
 * Attach this script to a single Entity named EWS_BUILDER.
 * It creates a clean, editable runtime hierarchy:
 *
 * EWS_CLUB
 *  ├─ ARCHITECTURE
 *  ├─ DANCEFLOOR
 *  ├─ SCREEN
 *  ├─ SPEAKERS
 *  ├─ BAR
 *  ├─ LIGHTING
 *  ├─ LASERS
 *  ├─ STROBES
 *  ├─ ATMOSPHERE
 *  ├─ PROPS
 *  └─ SPAWN_POINTS
 *
 * The scene dimensions are deliberately explicit so later gameplay
 * systems can share the same coordinates.
 */

export class EwsClubBuilder extends Script {
    static scriptName = 'ewsClubBuilder';

    /** @attribute @title "Rebuild on start" */
    rebuildOnStart = true;

    initialize() {
        if (this.rebuildOnStart) {
            this.build();
        }
    }

    build() {
        const app = this.app;

        const old = app.root.findByName('EWS_CLUB');
        if (old) old.destroy();

        const club = new pc.Entity('EWS_CLUB');
        app.root.addChild(club);

        const groups = [
            'ARCHITECTURE',
            'DANCEFLOOR',
            'SCREEN',
            'SPEAKERS',
            'BAR',
            'LIGHTING',
            'LASERS',
            'STROBES',
            'ATMOSPHERE',
            'PROPS',
            'SPAWN_POINTS'
        ];

        const nodes = {};

        for (const name of groups) {
            const node = new pc.Entity(name);
            club.addChild(node);
            nodes[name] = node;
        }

        this.buildArchitecture(nodes.ARCHITECTURE);
        this.buildDancefloor(nodes.DANCEFLOOR);
        this.buildScreen(nodes.SCREEN);
        this.buildSpeakers(nodes.SPEAKERS);
        this.buildBar(nodes.BAR);
        this.buildLighting(nodes.LIGHTING);
        this.buildSpawns(nodes.SPAWN_POINTS);

        console.log('[EWS 3.0] Club foundation created');
    }

    primitive(parent, name, type, position, scale, color) {
        const entity = new pc.Entity(name);
        parent.addChild(entity);

        entity.setLocalPosition(
            position[0],
            position[1],
            position[2]
        );

        entity.setLocalScale(
            scale[0],
            scale[1],
            scale[2]
        );

        entity.addComponent('render', {
            type
        });

        const material = new pc.StandardMaterial();
        material.diffuse = new pc.Color(
            color[0],
            color[1],
            color[2]
        );
        material.useMetalness = true;
        material.metalness = .25;
        material.shininess = 20;
        material.update();

        entity.render.material = material;

        return entity;
    }

    buildArchitecture(parent) {
        const wall = [0.045, 0.045, 0.05];
        const dark = [0.012, 0.012, 0.014];

        this.primitive(
            parent,
            'BACK_WALL',
            'box',
            [0, 4, -15.5],
            [36, 8, .5],
            wall
        );

        this.primitive(
            parent,
            'LEFT_WALL',
            'box',
            [-18, 4, 0],
            [.5, 8, 31],
            wall
        );

        this.primitive(
            parent,
            'RIGHT_WALL',
            'box',
            [18, 4, 0],
            [.5, 8, 31],
            wall
        );

        this.primitive(
            parent,
            'FRONT_WALL',
            'box',
            [0, 4, 15.5],
            [36, 8, .5],
            wall
        );

        this.primitive(
            parent,
            'CEILING',
            'box',
            [0, 7, 0],
            [36, .35, 31],
            dark
        );

        const trim = [0.11,0.11,0.12];

        for (let z = -12; z <= 12; z += 4) {
            this.primitive(
                parent,
                'CEILING_BEAM_' + z,
                'box',
                [0, 6.65, z],
                [33, .13, .13],
                trim
            );
        }
    }

    buildDancefloor(parent) {
        this.primitive(
            parent,
            'MAIN_DANCEFLOOR',
            'box',
            [0, .08, -1],
            [15, .16, 15],
            [.025,.025,.028]
        );

        const line = [.72,.72,.72];

        this.primitive(
            parent,
            'FLOOR_LINE_BACK',
            'box',
            [0, .18, -8.5],
            [15,.035,.035],
            line
        );

        this.primitive(
            parent,
            'FLOOR_LINE_FRONT',
            'box',
            [0, .18, 6.5],
            [15,.035,.035],
            line
        );

        this.primitive(
            parent,
            'FLOOR_LINE_LEFT',
            'box',
            [-7.5,.18,-1],
            [.035,.035,15],
            line
        );

        this.primitive(
            parent,
            'FLOOR_LINE_RIGHT',
            'box',
            [7.5,.18,-1],
            [.035,.035,15],
            line
        );

        for (let i = -3; i <= 3; i++) {
            this.primitive(
                parent,
                'FLOOR_GRID_X_' + i,
                'box',
                [i*2.1,.19,-1],
                [.018,.018,15],
                [.33,.33,.33]
            );

            this.primitive(
                parent,
                'FLOOR_GRID_Z_' + i,
                'box',
                [0,.19,-1+i*2.1],
                [15,.018,.018],
                [.33,.33,.33]
            );
        }
    }

    buildScreen(parent) {
        this.primitive(
            parent,
            'SCREEN_FRAME',
            'box',
            [0,5.15,-15.05],
            [15.2,6.9,.34],
            [.005,.005,.006]
        );

        const anchor = new pc.Entity('SCREEN_ANCHOR');
        parent.addChild(anchor);
        anchor.setLocalPosition(0,5.15,-15.34);
    }

    buildSpeakers(parent) {
        const positions = [-8.7, 8.7];

        for (const x of positions) {
            const stack = new pc.Entity(
                x < 0 ? 'LEFT_SPEAKER_STACK' : 'RIGHT_SPEAKER_STACK'
            );

            parent.addChild(stack);
            stack.setLocalPosition(x,0,-14.0);

            this.primitive(
                stack,
                'SUB',
                'box',
                [0,.78,0],
                [1.85,1.56,1.2],
                [.015,.015,.017]
            );

            this.primitive(
                stack,
                'MID_HIGH',
                'box',
                [0,2.95,0],
                [1.45,2.85,1],
                [.02,.02,.022]
            );

            for (let i = 0; i < 3; i++) {
                this.primitive(
                    stack,
                    'DRIVER_' + i,
                    'cylinder',
                    [0,2.16+i*.72,.52],
                    [.42,.08,.42],
                    [.06,.06,.065]
                );
            }
        }
    }

    buildBar(parent) {
        this.primitive(
            parent,
            'BAR_COUNTER',
            'box',
            [10.0,.78,-2.5],
            [7.4,1.15,1],
            [.07,.07,.075]
        );

        this.primitive(
            parent,
            'BAR_TOP',
            'box',
            [10.0,1.42,-2.5],
            [7.6,.22,1.1],
            [.22,.22,.23]
        );

        this.primitive(
            parent,
            'BAR_BACK',
            'box',
            [10.0,2.7,-3.0],
            [7.6,2.2,.28],
            [.025,.025,.028]
        );
    }

    buildLighting(parent) {
        const rigPositions = [
            [-6.5,6.35,-8.5],
            [ 6.5,6.35,-8.5],
            [-6.0,6.25, 3.0],
            [ 6.0,6.25, 3.0]
        ];

        rigPositions.forEach((position,index) => {
            const fixture = new pc.Entity(
                'MOVING_HEAD_' + index
            );

            parent.addChild(fixture);
            fixture.setLocalPosition(...position);

            fixture.addComponent('render',{
                type:'box'
            });

            fixture.setLocalScale(.35,.18,.55);
        });

        const ambient = new pc.Entity('CLUB_AMBIENT');
        parent.addChild(ambient);

        ambient.addComponent('light',{
            type:'omni',
            color:new pc.Color(1,1,1),
            intensity:.08,
            range:30
        });
    }

    buildSpawns(parent) {
        const points = [
            [0,10],
            [3,8],
            [-3,8],
            [6,5],
            [-6,5],
            [8,1],
            [-8,1],
            [4,-1],
            [-4,-1]
        ];

        points.forEach((point,index) => {
            const spawn = new pc.Entity(
                'SPAWN_' + index
            );

            parent.addChild(spawn);
            spawn.setLocalPosition(
                point[0],
                0,
                point[1]
            );
        });
    }
}
