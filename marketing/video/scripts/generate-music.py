"""Original Pilion instrumental. Synthesized locally; no samples or third-party tracks."""
import wave
from pathlib import Path
import numpy as np
RATE=48000
SECONDS=80
BPM=96
beat=60/BPM
rng=np.random.default_rng(420)
mix=np.zeros((RATE*SECONDS,2),dtype=np.float64)
def put(sound,t,gain=1,pan=0):
    start=int(t*RATE); end=min(len(mix),start+len(sound))
    if start<0 or end<=start:return
    s=sound[:end-start]*gain
    mix[start:end,0]+=s*np.sqrt((1-pan)/2)
    mix[start:end,1]+=s*np.sqrt((1+pan)/2)
def note(midi,dur,kind='pluck'):
    t=np.arange(int(dur*RATE))/RATE; f=440*2**((midi-69)/12)
    if kind=='pad':
        env=np.minimum(t/.7,1)*np.minimum((dur-t)/1.1,1)
        return (np.sin(2*np.pi*f*t)+.25*np.sin(2*np.pi*f*1.002*t)+.15*np.sin(4*np.pi*f*t))*env*.12
    if kind=='bass':return np.sin(2*np.pi*f*t)*np.exp(-t*3)*np.minimum(t/.015,1)*.24
    env=np.minimum(t/.009,1)*np.exp(-t*4.2)
    return (np.sin(2*np.pi*f*t)+.28*np.sin(4*np.pi*f*t)+.08*np.sin(6*np.pi*f*t))*env*.22
chords=[[57,60,64,67],[53,57,60,64],[60,64,67,71],[55,59,62,67]]
for bar in range(int(SECONDS/(beat*4))+1):
    base=bar*4*beat; chord=chords[bar%4]
    for i,n in enumerate(chord):put(note(n,beat*5,'pad'),base,.7,(i-1.5)*.38)
    for step in range(8):
        n=chord[[0,2,1,3,2,1,3,2][step]]+12
        snd=note(n,1.6); when=base+step*beat/2
        put(snd,when,.55,np.sin(step)*.5)
        put(snd,when+beat*.75,.12,-np.sin(step)*.5)
    for step in [0,2]:put(note(chord[0]-12,.48,'bass'),base+step*beat,.65)
    if base<5 or base>72:continue
    for step in range(4):
        t=np.arange(int(.2*RATE))/RATE
        kick=np.sin(2*np.pi*(43*t+4*(1-np.exp(-t*35))))*np.exp(-t*24)
        put(kick,base+step*beat,.1 if step%2 else .19)
        if step%2:
            snare=rng.normal(0,1,len(t))*np.exp(-t*38)*.045
            put(snare,base+step*beat,.4)
    for step in range(8):
        t=np.arange(int(.045*RATE))/RATE; noise=rng.normal(0,1,len(t)); high=noise-np.roll(noise,1)
        put(high*np.exp(-t*110),base+step*beat/2,.008,(-1)**step*.4)
t=np.arange(len(mix))/RATE
mix*=np.minimum(t/3,1)[:,None]*np.minimum((SECONDS-t)/4,1)[:,None]
mix*=.65/max(.65,np.max(np.abs(mix)))
out=Path(__file__).resolve().parents[1]/'public/audio/music-original.wav';out.parent.mkdir(parents=True,exist_ok=True)
with wave.open(str(out),'wb') as w:
    w.setnchannels(2);w.setsampwidth(2);w.setframerate(RATE);w.writeframes((mix*32767).astype('<i2').tobytes())
print(out)
