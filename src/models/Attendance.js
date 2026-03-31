module.exports = (sequelize, DataTypes) => {
  const Attendance = sequelize.define(
    'Attendance',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      emp_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      branch_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      shift_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('present', 'absent', 'half_day', 'half_day_early', 'on_leave'),
        defaultValue: 'absent',
      },
      first_check_in: DataTypes.DATE,
      last_check_out: DataTypes.DATE,
      total_worked_minutes: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      session_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      is_late: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      is_overtime: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      overtime_minutes: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      is_finalised: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      is_anomaly: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      is_manual: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      marked_by: DataTypes.UUID,
    },
    {
      tableName: 'attendance',
      timestamps: true,
      paranoid: true,
      underscored: true,
      indexes: [
        { fields: ['org_id', 'emp_id', 'date'], unique: true },
        { fields: ['org_id', 'date'] },
      ],
    }
  );

  Attendance.associate = (models) => {
    Attendance.belongsTo(models.Organisation, {
      foreignKey: 'org_id',
      as: 'organisation',
    });
    Attendance.belongsTo(models.Employee, {
      foreignKey: 'emp_id',
      as: 'employee',
    });
    Attendance.belongsTo(models.Shift, {
      foreignKey: 'shift_id',
      as: 'shift',
    });
    Attendance.hasMany(models.AttendanceSession, {
      foreignKey: 'attendance_id',
      as: 'sessions',
    });
  };

  return Attendance;
};
