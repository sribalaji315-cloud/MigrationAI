
import React, { useState } from 'react';
import { User, DatabaseState } from '../types';
import { dbService } from '../services/dbService';

interface LoginSignUpProps {
  onLogin: (user: User) => void;
}

const LoginSignUp: React.FC<LoginSignUpProps> = ({ onLogin }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [userName, setUserName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const modeResult = await dbService.getConnectionMode();

    if (isLogin) {
      if (modeResult === 'REMOTE_SQL') {
        try {
          await dbService.login(userName, password);
          const remoteUser = await dbService.me();
          onLogin({ userId: `USR-${remoteUser.id}`, userName: remoteUser.username, password: '', role: remoteUser.role });
          return;
        } catch (err: any) {
          setError('Invalid credentials. Access Denied.');
          return;
        }
      }

      // LOCAL_MOCK
      const { state } = await dbService.fetchAll();
      const users = state.users;
      const user = users.find(u => u.userName === userName && u.password === password);
      if (user) {
        onLogin(user);
      } else {
        setError('Invalid credentials. Access Denied.');
      }
    } else {
      if (modeResult === 'REMOTE_SQL') {
        try {
          await dbService.register(userName, password, 'user');
          // after register, perform login to get token and user info
          await dbService.login(userName, password);
          const remoteUser = await dbService.me();
          onLogin({ userId: `USR-${remoteUser.id}`, userName: remoteUser.username, password: '', role: remoteUser.role });
          return;
        } catch (err: any) {
          setError(err?.detail || 'Username already registered.');
          return;
        }
      }

      // LOCAL_MOCK register
      const { state } = await dbService.fetchAll();
      const users = state.users;
      if (users.some(u => u.userName === userName)) {
        setError('Username already registered.');
        return;
      }

      const newUser: User = {
        userId: `USR-${Math.floor(Math.random() * 9000) + 1000}`,
        userName,
        password,
        role: 'user'
      };

      state.users.push(newUser);
      await dbService.saveAll(state);
      onLogin(newUser);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900 flex items-center justify-center p-6">
      {/* Background Decor */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/20 blur-[120px] rounded-full"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-indigo-600/20 blur-[120px] rounded-full"></div>
      </div>

      <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-md p-10 relative z-10 border border-white/20">
        <div className="flex flex-col items-center mb-10">
          <div className="w-16 h-16 bg-blue-600 rounded-3xl flex items-center justify-center text-white mb-6 shadow-xl shadow-blue-200">
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <h1 className="text-2xl font-black text-slate-900 tracking-tight">ERP Data Migrator</h1>
          <p className="text-slate-400 text-xs font-bold uppercase tracking-widest mt-2">Enterprise PLM Bridge Access</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Identity ID</label>
            <input
              type="text"
              required
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 text-sm font-bold transition-all"
              placeholder="Enter username"
            />
          </div>

          <div>
            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Access Token</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-5 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 text-sm font-bold transition-all"
              placeholder="Enter password"
            />
          </div>

          {error && (
            <div className="bg-red-50 text-red-600 px-4 py-3 rounded-xl text-xs font-bold border border-red-100 animate-shake">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black text-xs uppercase tracking-[0.2em] shadow-xl shadow-slate-200 hover:bg-black transition-all active:scale-95"
          >
            {isLogin ? 'Establish Connection' : 'Register New Station'}
          </button>
        </form>

        <div className="mt-8 text-center">
          <button
            onClick={() => { setIsLogin(!isLogin); setError(''); }}
            className="text-slate-400 text-[10px] font-black uppercase tracking-widest hover:text-blue-600 transition-colors"
          >
            {isLogin ? "No access key? Register new ID" : "Already have an ID? Switch to Sign In"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default LoginSignUp;
