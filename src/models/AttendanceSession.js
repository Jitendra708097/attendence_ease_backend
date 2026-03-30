module.exports = (sequelize, DataTypes) => {
  const AttendanceSession = sequelize.define(
    'AttendanceSession',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      attendance_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      emp_id: {
        type: DataTypes.VIRTUAL,
        get() {
          return null;
        },
      },
      session_number: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      check_in_time: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      check_out_time: DataTypes.DATE,
      check_in_lat: {
        type: DataTypes.VIRTUAL,
        get() {
          return null;
        },
      },
      check_in_lng: {
        type: DataTypes.VIRTUAL,
        get() {
          return null;
        },
      },
      check_out_lat: {
        type: DataTypes.VIRTUAL,
        get() {
          return null;
        },
      },
      check_out_lng: {
        type: DataTypes.VIRTUAL,
        get() {
          return null;
        },
      },
      selfie_url: {
        type: DataTypes.VIRTUAL,
        get() {
          return null;
        },
      },
      worked_minutes: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      status: {
        type: DataTypes.ENUM('open', 'completed', 'auto_closed'),
        defaultValue: 'open',
      },
      is_undo_eligible: {
        type: DataTypes.VIRTUAL,
        get() {
          return false;
        },
      },
    },
    {
      tableName: 'attendance_sessions',
      paranoid: true,
      underscored: true,
    }
  );

  AttendanceSession.associate = (models) => {
    AttendanceSession.belongsTo(models.Attendance, {
      foreignKey: 'attendance_id',
      as: 'attendance',
    });
  };

  return AttendanceSession;
};
